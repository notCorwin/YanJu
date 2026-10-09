import { z } from 'zod'
import type { Channel } from './types.ts'
import { catalogSdk } from './provider-registry'

export const MODELS_DEV_URL = 'https://models.dev/api.json'

const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  structured_output: z.boolean().optional(),
  temperature: z.boolean().optional(),
  modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }),
  limit: z.object({
    context: z.number().nonnegative(),
    input: z.number().nonnegative().optional(),
    output: z.number().nonnegative().optional(),
  }),
  provider: z
    .object({
      npm: z.string().optional(),
      api: z.string().optional(),
      shape: z.string().optional(),
    })
    .optional(),
})
const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  npm: z.string(),
  api: z.string().optional(),
  env: z.array(z.string()).default([]),
  doc: z.string().optional(),
  models: z.record(z.string(), z.unknown()),
})
export type CatalogModel = z.infer<typeof modelSchema>
export type CatalogProvider = Omit<z.infer<typeof providerSchema>, 'models'> & {
  models: Record<string, CatalogModel>
}
export type ModelCatalog = Record<string, CatalogProvider>

/** Availability comes from the provider-specific entry, including model-level SDK/API overrides. */
export function parseModelCatalog(input: unknown): ModelCatalog {
  const catalog: ModelCatalog = {}
  for (const value of Object.values(z.record(z.string(), z.unknown()).parse(input))) {
    const parsed = providerSchema.safeParse(value)
    if (!parsed.success) continue
    const models: CatalogProvider['models'] = {}
    for (const raw of Object.values(parsed.data.models)) {
      const result = modelSchema.safeParse(raw)
      if (!result.success) continue
      const model = result.data
      if (
        model.modalities.input.includes('text') &&
        model.modalities.output.includes('text') &&
        model.limit.context > 0
      )
        models[model.id] = model
    }
    if (Object.keys(models).length) catalog[parsed.data.id] = { ...parsed.data, models }
  }
  if (!Object.keys(catalog).length) throw new Error('Models.dev 未返回可用的文本模型。')
  return catalog
}

export function catalogSelection(
  channel: Pick<Channel, 'providerId' | 'model'>,
  catalog: ModelCatalog,
) {
  const provider = catalog[channel.providerId]
  const model = provider?.models[channel.model]
  if (!provider || !model) throw new Error('请从 Models.dev 选择 Provider 和文本模型。')
  return {
    provider,
    model,
    sdk: model.provider?.npm ?? provider.npm,
    api: model.provider?.api ?? provider.api,
  }
}

/** Only catalog fields used by the SDK request builder belong to the tested route. */
export function catalogRouteFingerprint(
  channel: Pick<Channel, 'providerId' | 'model'>,
  catalog: ModelCatalog,
) {
  const { provider, model, sdk, api } = catalogSelection(channel, catalog)
  return JSON.stringify([
    provider.id,
    provider.npm,
    provider.env,
    model.id,
    sdk,
    api,
    model.provider?.shape,
    model.structured_output,
    model.temperature,
    model.limit.context,
    model.limit.input,
    model.limit.output,
  ])
}

export function selectCatalogModel(
  channel: Channel,
  provider: CatalogProvider,
  model: CatalogModel,
): Channel {
  const sdk = catalogSdk(model.provider?.npm ?? provider.npm)
  return {
    ...channel,
    providerId: provider.id,
    sdk,
    model: model.id,
    name:
      channel.name.trim() && channel.name !== '新渠道'
        ? channel.name
        : `${provider.name} · ${model.name}`,
    baseUrl: channel.providerId === provider.id ? channel.baseUrl : '',
    apiMode:
      ['@ai-sdk/google-vertex', '@ai-sdk/azure'].includes(provider.npm) ||
      !['@ai-sdk/openai', '@ai-sdk/openai-compatible'].includes(sdk)
        ? 'native'
        : model.provider?.shape === 'responses'
          ? 'responses'
          : ['completions', 'chat-completions'].includes(model.provider?.shape ?? '')
            ? 'chat-completions'
            : sdk === '@ai-sdk/openai'
              ? 'auto'
              : sdk === '@ai-sdk/openai-compatible'
                ? 'chat-completions'
                : 'native',
    contextWindow: model.limit.context,
    inputLimit: model.limit.input || model.limit.context,
    temperatureSupported: model.temperature === true,
    temperature: model.temperature === true ? channel.temperature : null,
    capability: undefined,
    calibration: undefined,
  }
}

/** Each caller can stop waiting without cancelling another caller's shared catalog load. */
function waitForCatalog<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Browser cache storage is best-effort and must never hold a request open. */
async function cachedValue<T>(operation: () => Promise<T>): Promise<T | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1000)
  try {
    return await waitForCatalog(operation(), controller.signal)
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

let current: ModelCatalog | undefined
let pending: Promise<ModelCatalog> | undefined
const catalogListeners = new Set<() => void>()
export function currentModelCatalog() {
  return current
}

export function subscribeModelCatalog(listener: () => void) {
  catalogListeners.add(listener)
  return () => {
    catalogListeners.delete(listener)
  }
}

function publishCatalog(catalog: ModelCatalog) {
  current = catalog
  for (const listener of catalogListeners) listener()
  return catalog
}

export function loadModelCatalog(refresh = false, signal?: AbortSignal): Promise<ModelCatalog> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  if (!refresh && current) return Promise.resolve(current)
  if (pending) return waitForCatalog(pending, signal)
  pending = (async () => {
    const cache =
      typeof caches === 'undefined'
        ? undefined
        : await cachedValue(() => caches.open('yanju-models-dev'))
    const url = MODELS_DEV_URL
    try {
      // Bound the shared network request even if every caller has stopped waiting.
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(new DOMException('模型目录加载超时', 'TimeoutError')),
        15_000,
      )
      let response: Response
      let catalog: ModelCatalog
      try {
        response = await waitForCatalog(
          fetch(url, { signal: controller.signal }),
          controller.signal,
        )
        if (!response.ok) throw new Error(`模型目录加载失败（HTTP ${response.status}）`)
        catalog = parseModelCatalog(
          await waitForCatalog(response.clone().json(), controller.signal),
        )
      } finally {
        clearTimeout(timer)
      }
      if (cache) await cachedValue(() => cache.put(MODELS_DEV_URL, response))
      return publishCatalog(catalog)
    } catch (error) {
      if (refresh) throw error
      const cached =
        cache &&
        (await cachedValue(async () => {
          const response = await cache.match(MODELS_DEV_URL)
          return response ? parseModelCatalog(await response.json()) : undefined
        }))
      if (!cached) throw error
      return publishCatalog(cached)
    }
  })().finally(() => {
    pending = undefined
  })
  return waitForCatalog(pending, signal)
}
