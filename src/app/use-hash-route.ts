export const subscribeRoute = (notify: () => void) => {
  window.addEventListener('hashchange', notify)
  return () => window.removeEventListener('hashchange', notify)
}

export const currentRoute = () => window.location.hash

export const archiveIdFromRoute = (route: string) => {
  if (!route.startsWith('#/chat/')) return ''
  try {
    return decodeURIComponent(route.slice(7).split('?')[0])
  } catch {
    return route.slice(7).split('?')[0]
  }
}
