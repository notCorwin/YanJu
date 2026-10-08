import { z } from 'zod'
import type { Channel } from './types.ts'

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
        model.structured_output === true &&
        model.modalities.input.includes('text') &&
        model.modalities.output.includes('text') &&
        model.limit.context > 0
      )
        models[model.id] = model
    }
    if (Object.keys(models).length) catalog[parsed.data.id] = { ...parsed.data, models }
  }
  if (!Object.keys(catalog).length)
    throw new Error('Models.dev 未返回可用的 Structured Outputs 模型。')
  return catalog
}

export function catalogSelection(
  channel: Pick<Channel, 'providerId' | 'model'>,
  catalog: ModelCatalog,
) {
  const provider = catalog[channel.providerId]
  const model = provider?.models[channel.model]
  if (!provider || !model)
    throw new Error('请从 Models.dev 选择支持 Structured Outputs 的 Provider 和模型。')
  return {
    provider,
    model,
    sdk: model.provider?.npm ?? provider.npm,
    api: model.provider?.api ?? provider.api,
  }
}

export function selectCatalogModel(
  channel: Channel,
  provider: CatalogProvider,
  model: CatalogModel,
): Channel {
  const sdk = model.provider?.npm ?? provider.npm
  return {
    ...channel,
    providerId: provider.id,
    sdk,
    model: model.id,
    name: `${provider.name} · ${model.name}`,
    baseUrl: model.provider?.api ?? provider.api ?? '',
    apiMode:
      ['ai-gateway-provider', '@ai-sdk/google-vertex', '@ai-sdk/azure'].includes(provider.npm) ||
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

let current: ModelCatalog | undefined
let pending: Promise<ModelCatalog> | undefined
export function loadModelCatalog(refresh = false): Promise<ModelCatalog> {
  if (!refresh && current) return Promise.resolve(current)
  if (pending) return pending
  pending = (async () => {
    const cache =
      typeof caches === 'undefined'
        ? undefined
        : await caches.open('yanju-models-dev').catch(() => undefined)
    const url = MODELS_DEV_URL
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`模型目录加载失败（HTTP ${response.status}）`)
      const catalog = parseModelCatalog(await response.clone().json())
      await cache?.put(MODELS_DEV_URL, response).catch(() => undefined)
      current = catalog
      return catalog
    } catch (error) {
      if (refresh) throw error
      const cached = await cache?.match(MODELS_DEV_URL)
      if (!cached) throw error
      current = parseModelCatalog(await cached.json())
      return current
    }
  })().finally(() => {
    pending = undefined
  })
  return pending
}
