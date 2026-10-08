import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { DeepPartial, ModelMessage } from 'ai'
import type { Reply, RequestKind, NarrativeReply, ForumReply } from './schemas'
import type { Channel, Usage } from './types'
import { compressionInstructions } from './prompts'
import type { CompressionInput } from './context'
import { runStructuredTask } from './task-runner'

export function channelFingerprint(channel: Channel) {
  // Bound capability results to exactly this endpoint/key/model, without storing another plaintext key.
  let hash = 2166136261
  for (const char of `${channel.baseUrl}\0${channel.apiKey}\0${channel.model}`)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return `${channel.baseUrl}|${channel.model}|${(hash >>> 0).toString(16)}`
}
export function channelIsReady(channel: Channel) {
  return !!channel.capability?.ok && channel.capability.fingerprint === channelFingerprint(channel)
}
export function validateChannel(channel: Channel) {
  if (!channel.name.trim() || !channel.model.trim() || !channel.apiKey.trim())
    throw new Error('请填写渠道名称、模型和 API Key。')
  const url = new URL(channel.baseUrl)
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Base URL 必须是 HTTP(S) 地址。')
  if (!Number.isFinite(channel.temperature) || channel.temperature < 0 || channel.temperature > 2)
    throw new Error('温度应在 0–2 之间。')
  if (!Number.isInteger(channel.contextWindow) || channel.contextWindow < 1024)
    throw new Error('上下文容量至少为 1,024 tokens。')
  if (
    !Number.isInteger(channel.maxOutputTokens) ||
    channel.maxOutputTokens < 128 ||
    channel.maxOutputTokens >= channel.contextWindow
  )
    throw new Error('输出上限须至少 128 tokens 且小于上下文容量。')
}
export function channelModel(channel: Channel, fetcher?: typeof fetch) {
  validateChannel(channel)
  const provider = createOpenAICompatible({
    name: 'yanju',
    baseURL: channel.baseUrl.replace(/\/+$/, ''),
    apiKey: channel.apiKey,
    supportsStructuredOutputs: true,
    includeUsage: true,
    ...(fetcher ? { fetch: fetcher } : {}),
  })
  return provider.chatModel(channel.model)
}
export const strictOptions = { yanju: { strictJsonSchema: true } }

export function friendlyError(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError')
    return '已停止生成，已保留收到的内容，可重试。'
  const message = error instanceof Error ? error.message : String(error)
  if (/fetch|network|cors/i.test(message))
    return '无法从浏览器连接渠道。请检查 Base URL、网络和服务端 CORS（允许本站来源、Authorization 与 Content-Type 请求头）。'
  if (/json_schema|response_format|structured|strict|unsupported/i.test(message))
    return `渠道未能完成严格结构化请求。请使用支持 json_schema / strict:true 的模型。${message}`
  if (/length|truncat|token limit/i.test(message))
    return '回复达到输出上限而被截断，已保留收到的内容。请提高输出上限后重试。'
  return message
}

export async function testChannel(channel: Channel, signal?: AbortSignal, fetcher?: typeof fetch) {
  await runStructuredTask({
    kind: 'capability',
    channel,
    signal,
    fetcher,
    input: { test: 'nested strict schema' },
  })
  return { fingerprint: channelFingerprint(channel), testedAt: Date.now(), ok: true }
}

export async function summarize(
  channel: Channel,
  input: CompressionInput,
  signal: AbortSignal,
  fetcher?: typeof fetch,
  archiveId?: string,
) {
  const result = await runStructuredTask({
    kind: 'compression',
    channel,
    input,
    signal,
    instructions: compressionInstructions,
    maxOutputTokens: Math.min(channel.maxOutputTokens, 4096),
    temperature: 0.3,
    fetcher,
    archiveId,
  })
  return result.value
}

export interface GenerationResult {
  reply: Reply
  usage: Usage | undefined
  correction?: string
}
interface GenerateOptions {
  archiveId?: string
  ownerId?: string
  channel: Channel
  kind: RequestKind
  instructions: string
  messages: ModelMessage[]
  signal: AbortSignal
  estimatedInput: number
  onPartial: (partial: DeepPartial<NarrativeReply> | DeepPartial<ForumReply>, raw?: string) => void
  onCorrection: (detail: string, correction: string) => void
  fetcher?: typeof fetch
  validate?: (reply: Reply) => void
}
export async function generateReply(options: GenerateOptions): Promise<GenerationResult> {
  if (options.kind === 'narrative') {
    const result = await runStructuredTask({
      ...options,
      kind: 'narrative',
      validate: (value) => options.validate?.({ kind: 'narrative', value }),
    })
    return {
      reply: { kind: 'narrative', value: result.value },
      usage: result.usage,
      correction: result.correction,
    }
  }
  const result = await runStructuredTask({
    ...options,
    kind: 'forum',
    validate: (value) => options.validate?.({ kind: 'forum', value }),
  })
  return {
    reply: { kind: 'forum', value: result.value },
    usage: result.usage,
    correction: result.correction,
  }
}
