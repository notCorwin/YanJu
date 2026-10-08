import { useSyncExternalStore } from 'react'

const subscribeRoute = (notify: () => void) => {
  window.addEventListener('hashchange', notify)
  return () => window.removeEventListener('hashchange', notify)
}
const currentRoute = () => window.location.hash

export function useHashRoute() {
  const route = useSyncExternalStore(subscribeRoute, currentRoute)
  let routeId = route.startsWith('#/chat/') ? route.slice(7) : ''
  try {
    routeId = decodeURIComponent(routeId)
  } catch {
    /* A malformed link displays the missing-archive state. */
  }
  return { route, routeId }
}
