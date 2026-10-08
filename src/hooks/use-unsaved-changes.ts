import { useEffect, useState } from 'react'

export function useUnsavedChanges(dirty: boolean) {
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)
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
      onConfirm: () => pendingAction?.(),
    },
  }
}
