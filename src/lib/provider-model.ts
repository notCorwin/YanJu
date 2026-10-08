import { wrapLanguageModel, type LanguageModel } from 'ai'
import type { LanguageModelV4 } from '@ai-sdk/provider'
import { catalogSelection, type ModelCatalog } from './model-catalog'
import type { ApiProtocol } from './types'

type Provider = {
  languageModel: (id: string) => Exclude<LanguageModel, string>
  chat?: (id: string) => Exclude<LanguageModel, string>
  responses?: (id: string) => Exclude<LanguageModel, string>
}
type Factory = (options: Record<string, unknown>) => Provider
// Use native browser SDKs, Vertex Edge modules, and HTTP adapters for Node-only packages.
const modules = {
  '@ai-sdk/openai': () => import('@ai-sdk/openai'),
  '@ai-sdk/openai-compatible': () => import('@ai-sdk/openai-compatible'),
  '@ai-sdk/anthropic': () => import('@ai-sdk/anthropic'),
  '@ai-sdk/azure': () => import('@ai-sdk/azure'),
  '@ai-sdk/google': () => import('@ai-sdk/google'),
  '@ai-sdk/google-vertex': () => import('@ai-sdk/google-vertex/edge'),
  '@ai-sdk/google-vertex/anthropic': () => import('@ai-sdk/google-vertex/anthropic/edge'),
  '@ai-sdk/amazon-bedrock': () => import('@ai-sdk/amazon-bedrock'),
  '@ai-sdk/amazon-bedrock/mantle': () => import('@ai-sdk/amazon-bedrock/mantle'),
  '@ai-sdk/groq': () => import('@ai-sdk/groq'),
  '@ai-sdk/deepinfra': () => import('@ai-sdk/deepinfra'),
  '@ai-sdk/cerebras': () => import('@ai-sdk/cerebras'),
  '@ai-sdk/cohere': () => import('@ai-sdk/cohere'),
  '@ai-sdk/mistral': () => import('@ai-sdk/mistral'),
  '@ai-sdk/togetherai': () => import('@ai-sdk/togetherai'),
  '@ai-sdk/perplexity': () => import('@ai-sdk/perplexity'),
  '@ai-sdk/xai': () => import('@ai-sdk/xai'),
  '@ai-sdk/gateway': () => import('@ai-sdk/gateway'),
  '@ai-sdk/vercel': () => import('@ai-sdk/vercel'),
  '@openrouter/ai-sdk-provider': () => import('@openrouter/ai-sdk-provider'),
  '@aihubmix/ai-sdk-provider': () => import('@aihubmix/ai-sdk-provider'),
  'venice-ai-sdk-provider': () => import('venice-ai-sdk-provider'),
  'gitlab-ai-provider': () => import('./browser-providers'),
  '@saladtechnologies-oss/ai-sdk-provider': () => import('@saladtechnologies-oss/ai-sdk-provider'),
  'merge-gateway-ai-sdk-provider': () => import('merge-gateway-ai-sdk-provider'),
  'watsonx-ai-provider': () => import('watsonx-ai-provider'),
  '@jerome-benoit/sap-ai-provider-v2': () => import('./browser-providers'),
  '@qvac/ai-sdk-provider': () => import('./browser-providers'),
  'ai-gateway-provider': () => import('ai-gateway-provider'),
} as const
export const supportedSdks = Object.keys(modules)
const factories: Record<string, string> = {
  '@ai-sdk/openai': 'createOpenAI',
  '@ai-sdk/openai-compatible': 'createOpenAICompatible',
  '@ai-sdk/anthropic': 'createAnthropic',
  '@ai-sdk/azure': 'createAzure',
  '@ai-sdk/google': 'createGoogleGenerativeAI',
  '@ai-sdk/google-vertex': 'createGoogleVertex',
  '@ai-sdk/google-vertex/anthropic': 'createGoogleVertexAnthropic',
  '@ai-sdk/amazon-bedrock': 'createAmazonBedrock',
  '@ai-sdk/amazon-bedrock/mantle': 'createBedrockMantle',
  '@ai-sdk/groq': 'createGroq',
  '@ai-sdk/deepinfra': 'createDeepInfra',
  '@ai-sdk/cerebras': 'createCerebras',
  '@ai-sdk/cohere': 'createCohere',
  '@ai-sdk/mistral': 'createMistral',
  '@ai-sdk/togetherai': 'createTogetherAI',
  '@ai-sdk/perplexity': 'createPerplexity',
  '@ai-sdk/xai': 'createXai',
  '@ai-sdk/gateway': 'createGateway',
  '@ai-sdk/vercel': 'createVercel',
  '@openrouter/ai-sdk-provider': 'createOpenRouter',
  '@aihubmix/ai-sdk-provider': 'createAihubmix',
  'venice-ai-sdk-provider': 'createVenice',
  'gitlab-ai-provider': 'createBrowserGitLab',
  '@saladtechnologies-oss/ai-sdk-provider': 'createSaladCloud',
  'merge-gateway-ai-sdk-provider': 'createMergeGateway',
  'watsonx-ai-provider': 'createWatsonx',
  '@jerome-benoit/sap-ai-provider-v2': 'createBrowserSAP',
  '@qvac/ai-sdk-provider': 'createBrowserQvac',
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
    const value = credential[key] ?? undefined
    if (typeof value !== 'string' || !value)
      throw new Error(`此 Provider 的 API Key 凭据 JSON 缺少 ${key}。`)
    return encodeURIComponent(value)
  })
}

export async function createProviderModel(
  catalog: ModelCatalog,
  providerId: string,
  modelId: string,
  key: string,
  fetcher?: typeof fetch,
  protocol?: ApiProtocol,
): Promise<LanguageModelV4> {
  const selected = catalogSelection({ providerId, model: modelId }, catalog)
  const { provider, model } = selected
  const vertexMaas =
    provider.npm === '@ai-sdk/google-vertex' && selected.sdk === '@ai-sdk/openai-compatible'
  let sdk = provider.npm === 'ai-gateway-provider' ? provider.npm : selected.sdk
  if (sdk === '@ai-sdk/google-vertex' && modelId.startsWith('claude-'))
    sdk = '@ai-sdk/google-vertex/anthropic'
  // OpenAI-compatible providers use the OpenAI Responses codec when that protocol is selected.
  if (
    sdk === '@ai-sdk/openai-compatible' &&
    (protocol === 'responses' || (!protocol && model.provider?.shape === 'responses'))
  )
    sdk = '@ai-sdk/openai'
  if (!Object.hasOwn(modules, sdk))
    throw new Error(`Models.dev 新增的 SDK ${sdk} 尚未包含在此版本中，请更新应用。`)
  let credential = readCredential(key)
  const service = credential.AICORE_SERVICE_KEY ?? credential.GOOGLE_APPLICATION_CREDENTIALS
  if (service !== undefined) {
    if (typeof service === 'string' && service.trim().startsWith('{'))
      credential = { ...credential, ...readCredential(service) }
    else if (service && typeof service === 'object' && !Array.isArray(service))
      credential = { ...credential, ...service }
    else
      throw new Error(
        '请在 API Key 中粘贴服务商导出的凭据 JSON 内容；浏览器无法读取本机凭据文件路径。',
      )
  }
  if (sdk.startsWith('@ai-sdk/amazon-bedrock'))
    credential.AWS_REGION ??= credential.region ?? 'us-east-1'
  if (provider.npm === '@ai-sdk/azure')
    credential[
      providerId === 'azure-cognitive-services'
        ? 'AZURE_COGNITIVE_SERVICES_RESOURCE_NAME'
        : 'AZURE_RESOURCE_NAME'
    ] ??= credential.resourceName
  if (vertexMaas) {
    credential.GOOGLE_VERTEX_PROJECT ??= credential.project ?? credential.project_id
    credential.GOOGLE_VERTEX_LOCATION ??= credential.location ?? 'global'
    const location = credential.GOOGLE_VERTEX_LOCATION
    credential.GOOGLE_VERTEX_ENDPOINT ??=
      location === 'global'
        ? 'aiplatform.googleapis.com'
        : ['eu', 'us'].includes(String(location))
          ? `aiplatform.${location}.rep.googleapis.com`
          : `${location}-aiplatform.googleapis.com`
  }
  const apiKey =
    typeof credential.accessToken === 'string'
      ? credential.accessToken
      : credentialApiKey(provider.env, credential)
  const api = resolveCatalogApi(selected.api, credential)
  const options: Record<string, unknown> = {
    apiKey,
    ...(api ? { baseURL: api } : {}),
    ...(fetcher ? { fetch: fetcher } : {}),
  }
  const auth = (key: string, env: string, fallback?: string) =>
    credential[key] ?? credential[env] ?? fallback
  if (sdk === '@ai-sdk/openai-compatible' || sdk === 'venice-ai-sdk-provider')
    Object.assign(options, {
      name: provider.id,
      supportsStructuredOutputs: true,
      includeUsage: true,
    })
  if (sdk === '@ai-sdk/anthropic')
    options.headers = { 'anthropic-dangerous-direct-browser-access': 'true' }
  if (provider.npm === '@ai-sdk/azure' && sdk !== '@ai-sdk/azure') {
    options.headers = { ...(options.headers as Record<string, string>), 'api-key': apiKey }
    if (sdk === '@ai-sdk/openai-compatible') {
      options.apiKey = undefined
      // Azure Model Inference requires a version and forwards model-specific schema/stream options.
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
      providerId === 'azure-cognitive-services'
        ? 'AZURE_COGNITIVE_SERVICES_RESOURCE_NAME'
        : 'AZURE_RESOURCE_NAME',
    )
    if (providerId === 'azure-cognitive-services' && options.resourceName)
      options.baseURL = `https://${options.resourceName}.services.ai.azure.com/openai/v1`
    if (!api && !options.resourceName)
      throw new Error(
        'Azure 的 API Key 凭据 JSON 需要包含 resourceName 或 Models.dev 所列的资源名称字段。',
      )
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
  if (sdk.startsWith('@ai-sdk/amazon-bedrock'))
    Object.assign(options, {
      region: auth('region', 'AWS_REGION', 'us-east-1'),
      accessKeyId: auth('accessKeyId', 'AWS_ACCESS_KEY_ID'),
      secretAccessKey: auth('secretAccessKey', 'AWS_SECRET_ACCESS_KEY'),
      sessionToken: auth('sessionToken', 'AWS_SESSION_TOKEN'),
    })
  if (sdk === 'watsonx-ai-provider') {
    options.projectId = auth('projectId', 'WATSONX_AI_PROJECT_ID')
    if (!options.projectId)
      throw new Error('watsonx 的 API Key 凭据 JSON 需要包含 WATSONX_AI_PROJECT_ID。')
  }
  if (sdk === '@jerome-benoit/sap-ai-provider-v2') {
    options.credential = credential
    options.resourceGroup = auth('resourceGroup', 'AICORE_RESOURCE_GROUP', 'default')
  }
  const loaded = (await modules[sdk as keyof typeof modules]()) as unknown as Record<
    string,
    unknown
  >
  let native: Exclude<LanguageModel, string>
  if (vertexMaas && options.googleCredentials) {
    const { createGoogleVertexMaas } = await import('@ai-sdk/google-vertex/maas/edge')
    native = createGoogleVertexMaas({
      ...options,
      fetch: async (input, init) => {
        const body = JSON.parse(String(init?.body))
        // The MaaS SDK inserts a hard-coded output cap for some models. The service owns capacity.
        delete body.max_tokens
        if (body.stream) body.stream_options = { include_usage: true }
        return (fetcher ?? fetch)(input, { ...init, body: JSON.stringify(body) })
      },
    }).languageModel(modelId)
    Object.assign(native, { supportsStructuredOutputs: true })
  } else if (sdk === 'ai-gateway-provider') {
    const { createAiGateway } = await import('ai-gateway-provider')
    const { createUnified } = await import('ai-gateway-provider/providers/unified')
    const account = auth('accountId', 'CLOUDFLARE_ACCOUNT_ID')
    const gateway = auth('gateway', 'CLOUDFLARE_GATEWAY_ID')
    if (!account || !gateway)
      throw new Error(
        'Cloudflare 的 API Key 凭据 JSON 需要包含 CLOUDFLARE_ACCOUNT_ID 和 CLOUDFLARE_GATEWAY_ID。',
      )
    const upstream = createUnified({
      supportsStructuredOutputs: true,
      includeUsage: true,
      apiKey: 'CF_TEMP_TOKEN',
    }).languageModel(modelId)
    // Use the SDK binding contract to inject browser fetch/diagnostics for its universal endpoint.
    native = createAiGateway({
      binding: {
        run: (data, { signal } = {}) =>
          (fetcher ?? fetch)(
            `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(String(account))}/${encodeURIComponent(String(gateway))}`,
            {
              method: 'POST',
              signal,
              headers: {
                'Content-Type': 'application/json',
                'cf-aig-authorization': `Bearer ${apiKey}`,
              },
              body: JSON.stringify(data),
            },
          ),
      },
    })(upstream)
  } else {
    const factory = loaded[factories[sdk]] as Factory | undefined
    if (typeof factory !== 'function') throw new Error(`SDK ${sdk} 没有可用的 Provider 工厂。`)
    const instance = factory(options)
    const deployment =
      typeof credential.deployments === 'object' && credential.deployments !== null
        ? (credential.deployments as Record<string, string>)[modelId]
        : undefined
    const id = deployment ?? modelId
    const chatShape = ['completions', 'chat-completions'].includes(model.provider?.shape ?? '')
    const responses =
      protocol === 'responses' ||
      (protocol !== 'chat-completions' &&
        (model.provider?.shape === 'responses' ||
          ((sdk === '@ai-sdk/openai' || sdk === '@ai-sdk/azure') && !chatShape)))
    native =
      responses && instance.responses
        ? instance.responses(id)
        : protocol === 'chat-completions' || chatShape
          ? (instance.chat ?? instance.languageModel)(id)
          : instance.languageModel(id)
    // TogetherAI's SDK hard-codes one supported model. Models.dev is our capability source.
    if (sdk === '@ai-sdk/togetherai') Object.assign(native, { supportsStructuredOutputs: true })
  }
  // Mantle reuses OpenAI codecs, whose options are read from the openai namespace.
  const namespace =
    sdk === '@ai-sdk/amazon-bedrock/mantle' ? 'openai' : native.provider.split('.')[0]
  return wrapLanguageModel({
    model: native,
    middleware: {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => ({
        ...params,
        // Anthropic requires this field. Use its published model capacity so SDK defaults cannot impose a smaller ceiling.
        ...((sdk === '@ai-sdk/anthropic' || sdk === '@ai-sdk/google-vertex/anthropic') &&
        model.limit.output
          ? { maxOutputTokens: model.limit.output }
          : {}),
        providerOptions: {
          ...params.providerOptions,
          [namespace]: {
            ...params.providerOptions?.[namespace],
            strictJsonSchema: true,
            ...(sdk === '@ai-sdk/anthropic' || sdk === '@ai-sdk/google-vertex/anthropic'
              ? { structuredOutputMode: 'outputFormat' }
              : {}),
            ...(native.provider.endsWith('.responses') ? { store: false } : {}),
            ...(sdk === '@ai-sdk/google' ? { structuredOutputs: true } : {}),
          },
        },
      }),
    },
  })
}
