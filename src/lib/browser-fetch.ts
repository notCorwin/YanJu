/** Let the browser set User-Agent; SDK telemetry triggers CORS preflights in Firefox/WebKit. */
export function createBrowserFetch(fetcher: typeof fetch = globalThis.fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    headers.delete('user-agent')
    return fetcher(input, { ...init, headers })
  }
}
