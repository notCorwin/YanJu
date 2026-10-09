let publishedRoute: string | undefined

export const subscribeRoute = (notify: () => void) => {
  const publish = () => {
    publishedRoute = window.location.hash
    notify()
  }
  window.addEventListener('hashchange', publish)
  return () => window.removeEventListener('hashchange', publish)
}

// Publish after navigation guards. Unrelated renders must not consume a pending
// browser location change before an editor can keep its unsaved draft on screen.
export const currentRoute = () => (publishedRoute ??= window.location.hash)

export const navigateRoute = (path: string) => {
  window.location.hash = path
}

export const archiveIdFromRoute = (route: string) => {
  if (!route.startsWith('#/chat/')) return ''
  try {
    return decodeURIComponent(route.slice(7).split('?')[0])
  } catch {
    return route.slice(7).split('?')[0]
  }
}
