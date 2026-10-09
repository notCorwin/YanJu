import { useEffect, useRef, useState } from 'react'

export function useUnsavedChanges(dirty: boolean, protectRoute = false) {
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)
  const approvedNavigation = useRef(false)
  useEffect(() => {
    if (!protectRoute) return
    let previous = window.location.hash
    const navigate = () => {
      const next = window.location.hash
      if (next === previous) return
      if (!dirty || approvedNavigation.current) {
        approvedNavigation.current = false
        previous = next
        return
      }
      window.history.replaceState(null, '', previous || '#/')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
      setPendingAction(() => () => {
        window.history.replaceState(null, '', next || '#/')
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      })
    }
    // Run before the route store publishes a new page and unmounts this editor.
    window.addEventListener('popstate', navigate, { capture: true })
    window.addEventListener('hashchange', navigate, { capture: true })
    return () => {
      window.removeEventListener('popstate', navigate, { capture: true })
      window.removeEventListener('hashchange', navigate, { capture: true })
    }
  }, [dirty, protectRoute])
  useEffect(() => {
    if (!dirty && pendingAction) {
      pendingAction()
      setPendingAction(null)
    }
  }, [dirty, pendingAction])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  return {
    guard: (action: () => void) => {
      if (dirty) setPendingAction(() => action)
      else action()
    },
    confirmation: {
      open: !!pendingAction,
      onClose: () => setPendingAction(null),
      onConfirm: () => {
        const previous = window.location.hash
        approvedNavigation.current = true
        pendingAction?.()
        if (window.location.hash === previous) approvedNavigation.current = false
      },
    },
  }
}
