/** Official AI SDK language providers, loaded on demand in the static browser app. */
export const providerModules = {
  '@ai-sdk/openai-compatible': () => import('@ai-sdk/openai-compatible'),
  '@ai-sdk/openai': () => import('@ai-sdk/openai'),
  '@ai-sdk/open-responses': () => import('@ai-sdk/open-responses'),
  '@ai-sdk/anthropic': () => import('@ai-sdk/anthropic'),
  '@ai-sdk/anthropic-aws': () => import('@ai-sdk/anthropic-aws'),
  '@ai-sdk/azure': () => import('@ai-sdk/azure'),
  '@ai-sdk/google': () => import('@ai-sdk/google'),
  '@ai-sdk/google-vertex': () => import('@ai-sdk/google-vertex/edge'),
  '@ai-sdk/google-vertex/anthropic': () => import('@ai-sdk/google-vertex/anthropic/edge'),
  '@ai-sdk/amazon-bedrock': () => import('@ai-sdk/amazon-bedrock'),
  '@ai-sdk/amazon-bedrock/mantle': () => import('@ai-sdk/amazon-bedrock/mantle'),
  '@ai-sdk/alibaba': () => import('@ai-sdk/alibaba'),
  '@ai-sdk/baseten': () => import('@ai-sdk/baseten'),
  '@ai-sdk/cerebras': () => import('@ai-sdk/cerebras'),
  '@ai-sdk/cohere': () => import('@ai-sdk/cohere'),
  '@ai-sdk/deepinfra': () => import('@ai-sdk/deepinfra'),
  '@ai-sdk/deepseek': () => import('@ai-sdk/deepseek'),
  '@ai-sdk/fireworks': () => import('@ai-sdk/fireworks'),
  '@ai-sdk/gateway': () => import('@ai-sdk/gateway'),
  '@ai-sdk/gmicloud': () => import('@ai-sdk/gmicloud'),
  '@ai-sdk/groq': () => import('@ai-sdk/groq'),
  '@ai-sdk/huggingface': () => import('@ai-sdk/huggingface'),
  '@ai-sdk/minimax': () => import('@ai-sdk/minimax'),
  '@ai-sdk/mistral': () => import('@ai-sdk/mistral'),
  '@ai-sdk/moonshotai': () => import('@ai-sdk/moonshotai'),
  '@ai-sdk/perplexity': () => import('@ai-sdk/perplexity'),
  '@ai-sdk/prodia': () => import('@ai-sdk/prodia'),
  '@ai-sdk/quiverai': () => import('@ai-sdk/quiverai'),
  '@ai-sdk/togetherai': () => import('@ai-sdk/togetherai'),
  '@ai-sdk/vercel': () => import('@ai-sdk/vercel'),
  '@ai-sdk/xai': () => import('@ai-sdk/xai'),
  '@ai-sdk/zai': () => import('@ai-sdk/zai'),
} as const

export type ProviderSdk = keyof typeof providerModules
export const supportedSdks = Object.keys(providerModules) as ProviderSdk[]
export const providerFactories: Record<ProviderSdk, string> = {
  '@ai-sdk/openai-compatible': 'createOpenAICompatible',
  '@ai-sdk/openai': 'createOpenAI',
  '@ai-sdk/open-responses': 'createOpenResponses',
  '@ai-sdk/anthropic': 'createAnthropic',
  '@ai-sdk/anthropic-aws': 'createAnthropicAws',
  '@ai-sdk/azure': 'createAzure',
  '@ai-sdk/google': 'createGoogle',
  '@ai-sdk/google-vertex': 'createGoogleVertex',
  '@ai-sdk/google-vertex/anthropic': 'createGoogleVertexAnthropic',
  '@ai-sdk/amazon-bedrock': 'createAmazonBedrock',
  '@ai-sdk/amazon-bedrock/mantle': 'createBedrockMantle',
  '@ai-sdk/alibaba': 'createAlibaba',
  '@ai-sdk/baseten': 'createBaseten',
  '@ai-sdk/cerebras': 'createCerebras',
  '@ai-sdk/cohere': 'createCohere',
  '@ai-sdk/deepinfra': 'createDeepInfra',
  '@ai-sdk/deepseek': 'createDeepSeek',
  '@ai-sdk/fireworks': 'createFireworks',
  '@ai-sdk/gateway': 'createGateway',
  '@ai-sdk/gmicloud': 'createGmicloud',
  '@ai-sdk/groq': 'createGroq',
  '@ai-sdk/huggingface': 'createHuggingFace',
  '@ai-sdk/minimax': 'createMiniMax',
  '@ai-sdk/mistral': 'createMistral',
  '@ai-sdk/moonshotai': 'createMoonshotAI',
  '@ai-sdk/perplexity': 'createPerplexity',
  '@ai-sdk/prodia': 'createProdia',
  '@ai-sdk/quiverai': 'createQuiverAI',
  '@ai-sdk/togetherai': 'createTogetherAI',
  '@ai-sdk/vercel': 'createVercel',
  '@ai-sdk/xai': 'createXai',
  '@ai-sdk/zai': 'createZai',
}

export function isProviderSdk(sdk: string): sdk is ProviderSdk {
  return Object.hasOwn(providerModules, sdk)
}

/** Community catalog entries use the one official OpenAI-compatible implementation. */
export function catalogSdk(sdk: string): ProviderSdk {
  return isProviderSdk(sdk) ? sdk : '@ai-sdk/openai-compatible'
}
