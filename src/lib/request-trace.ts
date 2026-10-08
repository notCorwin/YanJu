import type { Channel, RequestDiagnostics } from './types'

export class ChannelRequestError extends Error {
  constructor(
    error: unknown,
    public diagnostics: RequestDiagnostics,
  ) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
    this.name = error instanceof Error ? error.name : 'ChannelRequestError'
  }
}
export function errorDiagnostics(error: unknown) {
  return error instanceof ChannelRequestError ? error.diagnostics : undefined
}
export function requestTrace(channel: Channel, schema: string, fetcher: typeof fetch = fetch) {
  const data: RequestDiagnostics = {
    startedAt: Date.now(),
    elapsedMs: 0,
    corrections: 0,
    model: channel.model,
    schema,
  }
  return {
    data,
    fetch: (async (input, init) => {
      const response = await fetcher(input, init)
      data.httpStatus = response.status
      data.requestId =
        response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined
      return response
    }) satisfies typeof fetch,
    chunk: () => {
      data.firstTokenMs ??= Date.now() - data.startedAt
    },
    finish: (reason?: string) => ({
      ...data,
      elapsedMs: Date.now() - data.startedAt,
      finishReason: reason,
    }),
  }
}
export function requestTimeout(channel: Channel, streaming: boolean) {
  const milliseconds = channel.requestTimeoutMs ?? 300_000
  if (!milliseconds) return undefined
  return streaming
    ? { firstChunkMs: milliseconds, chunkMs: milliseconds }
    : { totalMs: milliseconds }
}
