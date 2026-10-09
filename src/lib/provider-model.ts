import { wrapLanguageModel, type LanguageModel } from 'ai'
import {
  UnsupportedFunctionalityError,
  type LanguageModelV4,
  type JSONObject,
} from '@ai-sdk/provider'
import { catalogSelection, type ModelCatalog } from './model-catalog'
import { createBrowserFetch } from './browser-fetch'
import {
  catalogSdk,
  providerFactories,
  providerModules,
  type ProviderSdk,
} from './provider-registry'
import type { ApiProtocol, OutputMode } from './types'
export { supportedSdks } from './provider-registry'

type Model = Exclude<LanguageModel, string>
type Provider = {
  languageModel: (id: string) => Model
  chat?: (id: string) => Model
  chatModel?: (id: string) => Model
  completionModel?: (id: string) => Model
  responses?: (id: string) => Model
  interactions?: (id: string) => Model
}
type Factory = (options: Record<string, unknown>) => Provider
export interface ModelSettings {
  baseUrl?: string
  sdk?: string
  customEndpoint?: boolean
  outputMode?: OutputMode
  schema?: JSONObject
  schemaName?: string
}

export function readCredential(value: string): Record<string, unknown> {
  if (!value.trim().startsWith('{')) return { apiKey: value.trim() }
  const credential: unknown = JSON.parse(value)
  if (!credential || typeof credential !== 'object' || Array.isArray(credential))
    throw new Error('API Key 凭据 JSON 无效。')
  return credential as Record<string, unknown>
}
export function credentialApiKey(env: string[], credential: Record<string, unknown>) {
  const value =
    credential.apiKey ??
    credential.token ??
    env
      .filter((name) => /API_?KEY|TOKEN|PAT/i.test(name))
      .map((name) => credential[name])
      .find((value) => typeof value === 'string')
  return typeof value === 'string' ? value : undefined
}
export function resolveCatalogApi(api: string | undefined, credential: Record<string, unknown>) {
  return api?.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => {
    const value = credential[key]
    if (typeof value !== 'string' || !value)
      throw new Error(`此 Provider 的 API Key 凭据 JSON 缺少 ${key}，也可填写 Base URL 覆盖地址。`)
    return encodeURIComponent(value)
  })
}

/** Accept an origin, API prefix, or one of the supported full endpoint URLs. */
export function endpointBaseURL(value: string, protocol: ApiProtocol) {
  const url = new URL(value)
  let path = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/(?:chat\/completions|completions|responses|messages|interactions)$/, '')
    .replace(/\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/, '')
  if (['generate-content', 'interactions', 'google-chat-completions'].includes(protocol)) {
    path = path.replace(/\/openai$/, '').replace(/\/v1$/, '/v1beta')
    if (!path) path = '/v1beta'
    if (protocol === 'google-chat-completions') path += '/openai'
  } else if (!path) path = '/v1'
  url.pathname = path
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

const protocolSdks: Partial<Record<ApiProtocol, ProviderSdk>> = {
  'chat-completions': '@ai-sdk/openai-compatible',
  completions: '@ai-sdk/openai-compatible',
  'google-chat-completions': '@ai-sdk/openai-compatible',
  responses: '@ai-sdk/openai',
  messages: '@ai-sdk/anthropic',
  'generate-content': '@ai-sdk/google',
  interactions: '@ai-sdk/google',
}

function containsSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsSchema)
  const object = value as Record<string, unknown>
  return Object.entries(object).some(
    ([name, child]) => /schema/i.test(name) || containsSchema(child),
  )
}

export async function createProviderModel(
  catalog: ModelCatalog,
  providerId: string,
  modelId: string,
  key: string,
  fetcher?: typeof fetch,
  protocol?: ApiProtocol,
  settings: ModelSettings = {},
): Promise<LanguageModelV4> {
  const selected = catalogSelection({ providerId, model: modelId }, catalog)
  const custom = settings.customEndpoint === true
  const chosenSdk =
    custom && protocol && protocol !== 'native'
      ? (protocolSdks[protocol] ?? '@ai-sdk/openai-compatible')
      : catalogSdk(settings.sdk ?? (custom ? '@ai-sdk/openai-compatible' : selected.sdk))
  // Catalog model metadata must never select a custom gateway's route or authentication.
  const provider = custom ? { id: 'custom', npm: chosenSdk, env: [] } : selected.provider
  const model = custom ? { ...selected.model, provider: undefined } : selected.model
  let sdk = protocolSdks[protocol ?? 'native'] ?? chosenSdk
  // These official SDKs retain cloud authentication while using the same wire protocol.
  if (
    protocol === 'responses' &&
    [
      '@ai-sdk/azure',
      '@ai-sdk/amazon-bedrock/mantle',
      '@ai-sdk/open-responses',
      '@ai-sdk/huggingface',
      '@ai-sdk/quiverai',
    ].includes(chosenSdk)
  )
    sdk = chosenSdk
  if (
    protocol === 'messages' &&
    ['@ai-sdk/anthropic-aws', '@ai-sdk/minimax', '@ai-sdk/google-vertex/anthropic'].includes(
      chosenSdk,
    )
  )
    sdk = chosenSdk
  if (sdk === '@ai-sdk/google-vertex' && modelId.startsWith('claude-'))
    sdk = '@ai-sdk/google-vertex/anthropic'
  if (
    (!protocol || protocol === 'native') &&
    model.provider?.shape === 'responses' &&
    sdk === '@ai-sdk/openai-compatible'
  )
    sdk = '@ai-sdk/openai'
  const vertexMaas =
    provider.npm === '@ai-sdk/google-vertex' &&
    chosenSdk === '@ai-sdk/openai-compatible' &&
    (!protocol || protocol === 'native')
  let credential = readCredential(key)
  const service = credential.GOOGLE_APPLICATION_CREDENTIALS
  if (service !== undefined) {
    if (typeof service === 'string' && service.trim().startsWith('{'))
      credential = { ...credential, ...readCredential(service) }
    else if (service && typeof service === 'object' && !Array.isArray(service))
      credential = { ...credential, ...service }
    else throw new Error('请在 API Key 中粘贴服务账户 JSON 内容；浏览器无法读取本机凭据文件路径。')
  }
  const auth = (name: string, env: string, fallback?: string) =>
    credential[name] ?? credential[env] ?? fallback
  if (sdk.startsWith('@ai-sdk/amazon-bedrock') || sdk === '@ai-sdk/anthropic-aws')
    credential.AWS_REGION ??= auth('region', 'AWS_REGION', 'us-east-1')
  if (provider.npm === '@ai-sdk/azure')
    credential[
      !custom && providerId === 'azure-cognitive-services'
        ? 'AZURE_COGNITIVE_SERVICES_RESOURCE_NAME'
        : 'AZURE_RESOURCE_NAME'
    ] ??= credential.resourceName
  if (sdk.startsWith('@ai-sdk/google-vertex') || vertexMaas) {
    credential.GOOGLE_VERTEX_PROJECT ??=
      auth('project', 'GOOGLE_VERTEX_PROJECT') ?? credential.project_id
    credential.GOOGLE_VERTEX_LOCATION ??= auth('location', 'GOOGLE_VERTEX_LOCATION', 'global')
    credential.GOOGLE_VERTEX_ENDPOINT ??=
      credential.GOOGLE_VERTEX_LOCATION === 'global'
        ? 'aiplatform.googleapis.com'
        : `${credential.GOOGLE_VERTEX_LOCATION}-aiplatform.googleapis.com`
  }
  const apiKey =
    typeof credential.accessToken === 'string'
      ? credential.accessToken
      : credentialApiKey(custom ? Object.keys(credential) : provider.env, credential)
  const override = settings.baseUrl?.trim()
  if (custom && !override) throw new Error('自定义端点需要填写 Base URL。')
  let api = resolveCatalogApi(override || (custom ? undefined : selected.api), credential)
  if (protocol && protocol !== 'native') {
    api ??=
      chosenSdk === '@ai-sdk/google'
        ? 'https://generativelanguage.googleapis.com/v1beta'
        : chosenSdk === '@ai-sdk/anthropic'
          ? 'https://api.anthropic.com/v1'
          : chosenSdk === '@ai-sdk/openai'
            ? 'https://api.openai.com/v1'
            : undefined
    if (api) api = endpointBaseURL(api, protocol)
  } else if (api && override) {
    const nativeProtocol: ApiProtocol | undefined =
      sdk === '@ai-sdk/google'
        ? 'generate-content'
        : ['@ai-sdk/anthropic', '@ai-sdk/minimax', '@ai-sdk/anthropic-aws'].includes(sdk)
          ? 'messages'
          : [
                '@ai-sdk/openai',
                '@ai-sdk/azure',
                '@ai-sdk/amazon-bedrock/mantle',
                '@ai-sdk/open-responses',
                '@ai-sdk/huggingface',
                '@ai-sdk/quiverai',
                '@ai-sdk/xai',
              ].includes(sdk)
            ? 'responses'
            : sdk === '@ai-sdk/openai-compatible'
              ? 'chat-completions'
              : undefined
    if (nativeProtocol) api = endpointBaseURL(api, nativeProtocol)
  }
  const outputMode = settings.outputMode ?? 'structured'
  const browserFetch = createBrowserFetch(fetcher)
  const requestFetch: typeof fetch = (input, init) => {
    if (typeof init?.body !== 'string' || !init.body.trim().startsWith('{'))
      return browserFetch(input, init)
    const body = JSON.parse(init.body)
    const requiredCapacity =
      native.provider.endsWith('.messages') || sdk === '@ai-sdk/google-vertex/anthropic'
    // Optional ceilings inserted by SDK defaults must not limit generation.
    for (const name of [
      'max_tokens',
      'max_completion_tokens',
      'max_output_tokens',
      'maxOutputTokens',
    ])
      if (!(requiredCapacity && name === 'max_tokens')) delete body[name]
    for (const config of [body.generationConfig, body.generation_config, body.inferenceConfig])
      if (config)
        for (const name of ['maxTokens', 'maxOutputTokens', 'max_output_tokens'])
          delete config[name]
    // The Messages wire protocol requires a ceiling; only the catalog's full capacity is used.
    if (requiredCapacity) {
      if (!model.limit.output)
        throw new Error('Models.dev 尚未提供此 Messages 模型必填的输出容量，请刷新模型目录。')
      body.max_tokens = model.limit.output
      if (outputMode === 'json' && settings.schema && sdk !== '@ai-sdk/anthropic-aws')
        body.output_config = { format: { type: 'json_object' } }
    }
    // The SDK completion codec does not expose response_format. Compatible completion endpoints may accept it.
    if (protocol === 'completions' && settings.schema && outputMode !== 'prompt')
      body.response_format =
        outputMode === 'structured'
          ? {
              type: 'json_schema',
              json_schema: { name: settings.schemaName, schema: settings.schema, strict: true },
            }
          : { type: 'json_object' }
    // Some native SDKs omit unsupported formats or silently choose JSON mode.
    // Detect that before sending, so the shared runner can include the schema in its fallback prompt.
    if (settings.schema && outputMode !== 'prompt') {
      const formats = [
        body.response_format,
        body.responseFormat,
        body.text?.format,
        body.output_config?.format,
        body.outputConfig,
        body.toolConfig,
        body.tools,
        body.generationConfig?.responseMimeType ? body.generationConfig : undefined,
        body.generation_config?.response_mime_type ? body.generation_config : undefined,
      ].filter(Boolean)
      if (!formats.length || (outputMode === 'structured' && !formats.some(containsSchema)))
        throw new UnsupportedFunctionalityError({
          functionality: `${outputMode} JSON response format`,
        })
    }
    return browserFetch(input, { ...init, body: JSON.stringify(body) })
  }
  const options: Record<string, unknown> = {
    apiKey,
    ...(api ? { baseURL: api } : {}),
    fetch: requestFetch,
  }
  if (sdk === '@ai-sdk/openai-compatible') {
    if (!api) throw new Error('Models.dev 未提供兼容 API 地址，请填写 Base URL。')
    Object.assign(options, {
      name: provider.id,
      supportsStructuredOutputs: true,
      includeUsage: true,
    })
  }
  if (sdk === '@ai-sdk/anthropic' || sdk === '@ai-sdk/minimax')
    options.headers = { 'anthropic-dangerous-direct-browser-access': 'true' }
  if (provider.npm === '@ai-sdk/azure' && sdk !== '@ai-sdk/azure') {
    options.headers = { ...(options.headers as Record<string, string>), 'api-key': apiKey }
    if (sdk === '@ai-sdk/openai-compatible') {
      options.apiKey = undefined
      options.queryParams = { 'api-version': '2025-04-01' }
      options.headers = {
        ...(options.headers as Record<string, string>),
        'extra-parameters': 'pass-through',
      }
    }
  }
  if (sdk === '@ai-sdk/azure') {
    options.resourceName = auth(
      'resourceName',
      !custom && providerId === 'azure-cognitive-services'
        ? 'AZURE_COGNITIVE_SERVICES_RESOURCE_NAME'
        : 'AZURE_RESOURCE_NAME',
    )
    if (!custom && providerId === 'azure-cognitive-services' && options.resourceName && !override)
      options.baseURL = `https://${options.resourceName}.services.ai.azure.com/openai/v1`
  }
  if (sdk.startsWith('@ai-sdk/google-vertex') || vertexMaas)
    Object.assign(options, {
      project: auth('project', 'GOOGLE_VERTEX_PROJECT') ?? credential.project_id,
      location: auth('location', 'GOOGLE_VERTEX_LOCATION', 'global'),
      ...(credential.client_email && credential.private_key
        ? {
            googleCredentials: {
              clientEmail: credential.client_email,
              privateKey: credential.private_key,
              privateKeyId: credential.private_key_id,
            },
          }
        : {}),
      ...(sdk === '@ai-sdk/google-vertex/anthropic' && typeof credential.accessToken === 'string'
        ? { generateAuthToken: async () => credential.accessToken }
        : {}),
    })
  if (sdk.startsWith('@ai-sdk/amazon-bedrock') || sdk === '@ai-sdk/anthropic-aws')
    Object.assign(options, {
      region: auth('region', 'AWS_REGION', 'us-east-1'),
      accessKeyId: auth('accessKeyId', 'AWS_ACCESS_KEY_ID'),
      secretAccessKey: auth('secretAccessKey', 'AWS_SECRET_ACCESS_KEY'),
      sessionToken: auth('sessionToken', 'AWS_SESSION_TOKEN'),
      ...(sdk === '@ai-sdk/anthropic-aws'
        ? { workspaceId: auth('workspaceId', 'ANTHROPIC_AWS_WORKSPACE_ID') }
        : {}),
    })
  let native: Model
  if (vertexMaas && options.googleCredentials) {
    const { createGoogleVertexMaas } = await import('@ai-sdk/google-vertex/maas/edge')
    native = createGoogleVertexMaas(options).languageModel(modelId)
  } else {
    const loaded = (await providerModules[sdk]()) as unknown as Record<string, unknown>
    const factory = loaded[providerFactories[sdk]] as Factory
    const instance = factory(options)
    const deployments = credential.deployments
    const id =
      deployments && typeof deployments === 'object' && !Array.isArray(deployments)
        ? ((deployments as Record<string, string>)[modelId] ?? modelId)
        : modelId
    if (protocol === 'completions') native = instance.completionModel!(id)
    else if (protocol === 'interactions') native = instance.interactions!(id)
    else if (
      (protocol === 'responses' ||
        ((!protocol || protocol === 'native') && model.provider?.shape === 'responses')) &&
      instance.responses
    )
      native = instance.responses(id)
    else if (['chat-completions', 'google-chat-completions'].includes(protocol ?? ''))
      native = (instance.chatModel ?? instance.chat ?? instance.languageModel)(id)
    else if (
      (!protocol || protocol === 'native') &&
      ['completions', 'chat-completions'].includes(model.provider?.shape ?? '')
    )
      native = (instance.chatModel ?? instance.chat ?? instance.languageModel)(id)
    else native = instance.languageModel(id)
  }
  if (sdk === '@ai-sdk/togetherai' || vertexMaas)
    Object.assign(native, { supportsStructuredOutputs: true })
  const namespace =
    sdk === '@ai-sdk/amazon-bedrock/mantle' ? 'openai' : native.provider.split('.')[0]
  return wrapLanguageModel({
    model: native,
    middleware: {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => {
        const format = settings.schema
          ? { type: 'json' as const, schema: settings.schema, name: settings.schemaName }
          : params.responseFormat
        return {
          ...params,
          maxOutputTokens:
            native.provider.endsWith('.messages') || sdk === '@ai-sdk/google-vertex/anthropic'
              ? model.limit.output
              : undefined,
          responseFormat:
            outputMode === 'prompt'
              ? undefined
              : outputMode === 'json'
                ? { type: 'json' as const }
                : format,
          providerOptions: {
            ...params.providerOptions,
            [namespace]: {
              ...params.providerOptions?.[namespace],
              strictJsonSchema: true,
              ...(native.provider.endsWith('.messages') || sdk === '@ai-sdk/google-vertex/anthropic'
                ? { structuredOutputMode: 'outputFormat' }
                : {}),
              ...(native.provider.endsWith('.responses') || protocol === 'interactions'
                ? { store: false }
                : {}),
              ...(sdk === '@ai-sdk/google'
                ? { structuredOutputs: outputMode === 'structured' }
                : {}),
            },
          },
        }
      },
    },
  })
}
