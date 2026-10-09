import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  capabilityFixture,
  channelFixture,
  completion,
  response,
  responseSse,
  sse,
} from '../fixtures'
import { catalogFixture } from '../model-catalog-fixture'
import type { ApiMode } from '../../src/lib/types'

vi.unmock('../../src/lib/model-catalog')

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

function probeFetch() {
  return vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const responses = String(url).endsWith('/responses')
    return JSON.parse(String(init?.body)).stream
      ? new Response(
          (responses ? responseSse(capabilityFixture) : sse(capabilityFixture)).join(''),
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        )
      : Response.json(responses ? response(capabilityFixture) : completion(capabilityFixture))
  })
}

async function setup(apiMode: ApiMode = 'chat-completions') {
  const source = catalogFixture()
  const catalogFetch = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(source))
  vi.stubGlobal('fetch', catalogFetch)
  const catalog = await import('../../src/lib/model-catalog')
  const provider = await import('../../src/lib/provider')
  const channel = { ...channelFixture, apiMode }
  const capability = await provider.testChannel(channel, undefined, probeFetch())
  expect(capability.ok).toBe(true)
  const tested = { ...channel, capability }
  expect(provider.channelIsReady(tested)).toBe(true)
  return { source, catalogFetch, catalog, provider, tested }
}

describe('catalog-bound capability proof', () => {
  it.each(['auto', 'responses', 'chat-completions', 'native'] as const)(
    'invalidates %s proof before the next request when the model API changes',
    async (mode) => {
      const { source, catalog, provider, tested } = await setup(mode)
      Object.assign(source.mock.models['test-model'], {
        provider: { api: 'https://new-catalog.example/v2' },
      })
      await catalog.loadModelCatalog(true)
      expect(provider.channelIsReady(tested)).toBe(false)
      await expect(
        provider.channelRequest(tested, vi.fn(), tested.capability.protocol),
      ).rejects.toThrow(/重新测试/)
    },
  )

  it.each([
    [
      'model SDK',
      (source: ReturnType<typeof catalogFixture>) =>
        Object.assign(source.mock.models['test-model'], {
          provider: { npm: '@ai-sdk/openai-compatible' },
        }),
    ],
    [
      'provider SDK',
      (source: ReturnType<typeof catalogFixture>) => {
        source.mock.npm = '@ai-sdk/azure'
      },
    ],
    [
      'model shape',
      (source: ReturnType<typeof catalogFixture>) =>
        Object.assign(source.mock.models['test-model'], { provider: { shape: 'responses' } }),
    ],
    [
      'authentication fields',
      (source: ReturnType<typeof catalogFixture>) => {
        source.mock.env = ['NEW_API_KEY']
      },
    ],
  ])('invalidates proof when %s changes', async (_name, change) => {
    const { source, catalog, provider, tested } = await setup()
    change(source)
    await catalog.loadModelCatalog(true)
    expect(provider.channelIsReady(tested)).toBe(false)
    await expect(provider.channelRequest(tested, vi.fn(), 'chat-completions')).rejects.toThrow(
      /重新测试/,
    )
  })

  it('keeps proof across display-only and unrelated catalog updates', async () => {
    const { source, catalog, provider, tested } = await setup()
    source.mock.name = 'Renamed provider'
    source.mock.models['test-model'].name = 'Renamed model'
    source.mock.models['second-model'].limit.context = 262144
    await catalog.loadModelCatalog(true)
    expect(provider.channelIsReady(tested)).toBe(true)
    await expect(provider.channelRequest(tested)).resolves.toHaveProperty('model')
  })

  it('checks saved proof against the first catalog loaded after a restart', async () => {
    const { source, tested } = await setup()
    source.mock.api = 'https://new-catalog.example/v2'
    vi.resetModules()
    const provider = await import('../../src/lib/provider')
    // The saved proof can be shown before the catalog is available, but cannot send a new route.
    expect(provider.channelIsReady(tested)).toBe(true)
    await expect(provider.channelRequest(tested, vi.fn(), 'chat-completions')).rejects.toThrow(
      /重新测试/,
    )
    expect(provider.channelIsReady(tested)).toBe(false)
  })

  it('requires a retest for legacy proofs that never recorded their catalog route', async () => {
    const { provider, tested } = await setup()
    delete tested.capability.catalogFingerprint
    expect(provider.channelIsReady(tested)).toBe(false)
    await expect(provider.channelRequest(tested, vi.fn(), 'chat-completions')).rejects.toThrow(
      /重新测试/,
    )
  })

  it('invalidates proof if the selected model is no longer available', async () => {
    const { source, catalog, provider, tested } = await setup()
    delete source.mock.models['test-model']
    await catalog.loadModelCatalog(true)
    expect(provider.channelIsReady(tested)).toBe(false)
    await expect(provider.channelRequest(tested, vi.fn(), 'chat-completions')).rejects.toThrow(
      /重新测试/,
    )
  })

  it('notifies readiness subscribers after publishing the new catalog', async () => {
    const { source, catalog, provider, tested } = await setup()
    const listener = vi.fn(() => provider.channelIsReady(tested))
    const unsubscribe = catalog.subscribeModelCatalog(listener)
    source.mock.api = 'https://new-catalog.example/v2'
    await catalog.loadModelCatalog(true)
    expect(listener).toHaveReturnedWith(false)
    expect(catalog.currentModelCatalog()?.mock.api).toBe(source.mock.api)
    unsubscribe()
    await catalog.loadModelCatalog(true)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('blocks the task runner before any provider traffic even with an explicit protocol', async () => {
    const { source, catalog, tested } = await setup()
    source.mock.api = 'https://new-catalog.example/v2'
    await catalog.loadModelCatalog(true)
    const { runStructuredTask } = await import('../../src/lib/task-runner')
    const fetcher = probeFetch()
    await expect(
      runStructuredTask({
        kind: 'persona',
        channel: tested,
        protocol: 'chat-completions',
        fetcher,
      }),
    ).rejects.toThrow(/重新测试/)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('retesting adopts the new catalog route and clears calibration for the old route', async () => {
    const { source, catalog, provider, tested } = await setup()
    source.mock.api = 'https://new-catalog.example/v2'
    await catalog.loadModelCatalog(true)
    const fetcher = probeFetch()
    const capability = await provider.testChannel(tested, undefined, fetcher)
    const { withCapability } = await import('../../src/lib/channels')
    const updated = withCapability({ ...tested, calibration: { ratio: 2, samples: 3 } }, capability)
    expect(provider.channelIsReady(updated)).toBe(true)
    expect(updated.calibration).toBeUndefined()
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(source.mock.api))).toBe(true)
    await expect(provider.channelRequest(updated)).resolves.toHaveProperty('model')
  })

  it('does not certify a refreshed route using probes sent to the previous route', async () => {
    const { source, catalog, provider, tested } = await setup()
    const responses = probeFetch()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (...args) => {
      if (fetcher.mock.calls.length === 1) {
        source.mock.api = 'https://new-catalog.example/v2'
        await catalog.loadModelCatalog(true)
      }
      return responses(...args)
    })
    const capability = await provider.testChannel(tested, undefined, fetcher)
    expect(capability.ok).toBe(false)
    expect(capability.error).toMatch(/测试期间已变更/)
    expect(provider.channelIsReady({ ...tested, capability })).toBe(false)
    expect(
      fetcher.mock.calls.every(([url]) => String(url).startsWith(channelFixture.baseUrl)),
    ).toBe(true)
  })
})
