import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogFixture } from '../model-catalog-fixture'
import { capabilityFixture, channelFixture, completion, sse } from '../fixtures'

vi.unmock('../../src/lib/model-catalog')

beforeEach(() => vi.resetModules())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('catalog cancellation', () => {
  it('cancels one waiter without cancelling the shared fetch or its other waiter', async () => {
    const response = deferred<Response>()
    const fetcher = vi.fn().mockReturnValue(response.promise)
    vi.stubGlobal('fetch', fetcher)
    const { loadModelCatalog } = await import('../../src/lib/model-catalog')
    const controller = new AbortController()
    const cancelled = loadModelCatalog(false, controller.signal)
    const other = loadModelCatalog()
    const result = cancelled.then(
      () => 'resolved',
      (error: Error) => error.name,
    )
    controller.abort()
    expect(
      await Promise.race([
        result,
        new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 50)),
      ]),
    ).toBe('AbortError')
    response.resolve(Response.json(catalogFixture()))
    expect((await other).mock.id).toBe('mock')
    expect(fetcher).toHaveBeenCalledOnce()
    expect((await loadModelCatalog()).mock.id).toBe('mock')
  })

  it('keeps waiting for a slow catalog instead of timing out or using stale cache', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const response = deferred<Response>()
    const fetcher = vi.fn().mockReturnValue(response.promise)
    const match = vi.fn(async () => Response.json(catalogFixture()))
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('caches', {
      open: async () => ({
        match,
        put: async () => {},
      }),
    })
    const { loadModelCatalog } = await import('../../src/lib/model-catalog')
    const request = loadModelCatalog()
    const settled = vi.fn()
    void request.then(settled, settled)
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(settled).not.toHaveBeenCalled()
    expect(match).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledOnce()
    response.resolve(Response.json(catalogFixture()))
    expect((await request).mock.id).toBe('mock')
  })

  it('falls back to cache on a network error and permits a later refresh', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetcher)
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async () => Response.json(catalogFixture()),
        put: async () => {},
      }),
    })
    const { loadModelCatalog } = await import('../../src/lib/model-catalog')
    expect((await loadModelCatalog()).mock.id).toBe('mock')
    fetcher.mockResolvedValueOnce(Response.json(catalogFixture()))
    await expect(loadModelCatalog(true)).resolves.toHaveProperty('mock')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not start a fetch for an already cancelled caller', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const { loadModelCatalog } = await import('../../src/lib/model-catalog')
    const controller = new AbortController()
    controller.abort()
    await expect(loadModelCatalog(false, controller.signal)).rejects.toHaveProperty(
      'name',
      'AbortError',
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not wait indefinitely on cache storage', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(catalogFixture())))
    vi.stubGlobal('caches', { open: () => new Promise(() => {}) })
    const { loadModelCatalog } = await import('../../src/lib/model-catalog')
    const request = loadModelCatalog()
    await vi.advanceTimersByTimeAsync(1000)
    await expect(request).resolves.toHaveProperty('mock')
  })

  it.each([true, false])(
    'completes after a long catalog wait (streaming=%s)',
    async (streaming) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const response = deferred<Response>()
      vi.stubGlobal(
        'fetch',
        vi.fn(() => response.promise),
      )
      const providerFetch = vi.fn<typeof fetch>().mockResolvedValue(
        streaming
          ? new Response(sse(capabilityFixture).join(''), {
              headers: { 'content-type': 'text/event-stream' },
            })
          : Response.json(completion(capabilityFixture)),
      )
      const { runStructuredTask } = await import('../../src/lib/task-runner')
      const task = runStructuredTask({
        kind: 'capability',
        channel: channelFixture,
        streaming,
        fetcher: providerFetch,
      })
      const settled = vi.fn()
      void task.then(settled, settled)
      await vi.advanceTimersByTimeAsync(86_400_000)
      expect(settled).not.toHaveBeenCalled()
      expect(providerFetch).not.toHaveBeenCalled()
      response.resolve(Response.json(catalogFixture()))
      await expect(task).resolves.toHaveProperty('value', capabilityFixture)
      expect(providerFetch).toHaveBeenCalledOnce()
    },
  )

  it.each([true, false])(
    'stops a task waiting for its catalog (streaming=%s) before any provider request',
    async (streaming) => {
      const response = deferred<Response>()
      const started = deferred<void>()
      vi.stubGlobal(
        'fetch',
        vi.fn(() => {
          started.resolve()
          return response.promise
        }),
      )
      const providerFetch = vi.fn()
      const { runStructuredTask } = await import('../../src/lib/task-runner')
      const controller = new AbortController()
      const task = runStructuredTask({
        kind: 'capability',
        channel: channelFixture,
        streaming,
        signal: controller.signal,
        fetcher: providerFetch,
      })
      const result = task.then(
        () => 'resolved',
        (error: Error) => error.message,
      )
      await started.promise
      controller.abort()
      const outcome = await Promise.race([
        result,
        new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 50)),
      ])
      response.resolve(Response.json(catalogFixture()))
      await result
      expect(outcome).not.toBe('still pending')
      expect(providerFetch).not.toHaveBeenCalled()
    },
  )
})
