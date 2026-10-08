import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
  generateText,
  Output,
  streamText,
  type DeepPartial,
  type ModelMessage,
  type LanguageModelUsage,
} from 'ai'
import { z } from 'zod'
import {
  ContentValidationError,
  compressionSchema,
  narrativeSchema,
  forumSchema,
  validateCompression,
  validateForum,
  validateNarrative,
  sanitizePartial,
  type Reply,
  type RequestKind,
  type NarrativeReply,
  type ForumReply,
} from './schemas'
import type { Channel, Usage } from './types'
import { compressionInstructions } from './prompts'
import type { CompressionInput } from './context'

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
  const result = await generateText({
    model: channelModel(channel, fetcher),
    output: Output.object({
      schema: z.strictObject({ ready: z.boolean(), echo: z.string() }),
      name: 'ChannelCapability',
    }),
    prompt:
      'Return ready=true and echo="YanJu strict output". This tests JSON Schema Structured Outputs.',
    maxOutputTokens: channel.maxOutputTokens,
    temperature: channel.temperature,
    maxRetries: 0,
    abortSignal: signal,
    providerOptions: strictOptions,
  })
  if (!result.output.ready || result.output.echo !== 'YanJu strict output')
    throw new Error('渠道结构化测试返回内容不符合测试要求。')
  return { fingerprint: channelFingerprint(channel), testedAt: Date.now(), ok: true }
}

export async function summarize(channel: Channel, input: CompressionInput, signal: AbortSignal) {
  let correction = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await generateText({
        model: channelModel(channel),
        instructions: compressionInstructions,
        prompt: JSON.stringify(input) + correction,
        output: Output.object({ schema: compressionSchema, name: 'CompressionResult' }),
        maxOutputTokens: Math.min(channel.maxOutputTokens, 4096),
        temperature: 0.3,
        providerOptions: strictOptions,
        abortSignal: signal,
        maxRetries: 0,
      })
      if (result.finishReason === 'length')
        throw new Error('摘要被输出上限截断。请增加输出上限后重试压缩。')
      return validateCompression(result.output)
    } catch (error) {
      const invalid =
        error instanceof ContentValidationError ||
        (error instanceof Error &&
          /NoObjectGenerated|NoOutputGenerated|JSONParse|TypeValidation|ZodError/i.test(error.name))
      if (attempt || signal.aborted || !invalid) throw error
      correction = `\n修正上次结果：${friendlyError(error)}。返回相同 schema 的完整非空摘要。`
    }
  }
  throw new Error('摘要校验失败')
}

export interface GenerationResult {
  reply: Reply
  usage: Usage | undefined
  correction?: string
}
interface GenerateOptions {
  channel: Channel
  kind: RequestKind
  instructions: string
  messages: ModelMessage[]
  signal: AbortSignal
  estimatedInput: number
  onPartial: (partial: DeepPartial<NarrativeReply> | DeepPartial<ForumReply>, raw?: string) => void
  onCorrection: (detail: string, correction: string) => void
  fetcher?: typeof fetch
}
function usageData(
  channel: Channel,
  usage: LanguageModelUsage,
  estimated: number,
): Usage | undefined {
  if (usage.inputTokens === undefined) return undefined
  return {
    input: usage.inputTokens,
    output: usage.outputTokens ?? 0,
    total: usage.totalTokens ?? usage.inputTokens + (usage.outputTokens ?? 0),
    measuredAt: Date.now(),
    estimatedInput: estimated,
    channelId: channel.id,
  }
}

export async function generateReply(options: GenerateOptions): Promise<GenerationResult> {
  const { channel, kind, instructions, messages, signal, onPartial, onCorrection } = options
  let correction: string | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    let streamError: unknown
    const stream = streamText({
      model: channelModel(channel, options.fetcher),
      instructions,
      // The system message in modelMessages is our own committed history summary.
      allowSystemInMessages: true,
      messages: [
        ...messages,
        ...(correction ? [{ role: 'user' as const, content: correction }] : []),
      ],
      output:
        kind === 'narrative'
          ? Output.object({ schema: narrativeSchema, name: 'NarrativeReply' })
          : Output.object({ schema: forumSchema, name: 'ForumReply' }),
      maxOutputTokens: channel.maxOutputTokens,
      temperature: channel.temperature,
      abortSignal: signal,
      maxRetries: 0,
      providerOptions: strictOptions,
      onError: ({ error }) => {
        streamError = error
      },
    })
    // Consume the final output promise immediately so malformed output never causes an unhandled rejection.
    const outcome = Promise.resolve(stream.output).then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    try {
      for await (const partial of stream.partialOutputStream) {
        if (signal.aborted) throw new DOMException('已取消', 'AbortError')
        onPartial(sanitizePartial(kind, partial), JSON.stringify(partial))
      }
      if (signal.aborted) throw new DOMException('已取消', 'AbortError')
      const finishReason = await stream.finishReason
      if (finishReason === 'length') throw new Error('truncated: token limit')
      if (streamError) throw streamError
      const resolved = await outcome
      if ('error' in resolved) throw resolved.error
      const reply: Reply =
        kind === 'narrative'
          ? { kind, value: validateNarrative(resolved.value) }
          : { kind, value: validateForum(resolved.value) }
      return {
        reply,
        usage: usageData(channel, await stream.usage, options.estimatedInput),
        correction,
      }
    } catch (error) {
      if (signal.aborted || attempt || /truncated|token limit/i.test(friendlyError(error)))
        throw error
      if (streamError) throw streamError
      // Only schema/content failures receive one same-schema correction. Network/auth/capability errors surface immediately.
      const invalid =
        error instanceof ContentValidationError ||
        (error instanceof Error &&
          /NoObjectGenerated|NoOutputGenerated|JSONParse|TypeValidation/i.test(error.name))
      if (!invalid) throw error
      const detail = friendlyError(error)
      correction = `上次回复校验失败：${detail}。请纠正并重新输出同一 schema 的完整对象，保留本轮剧情意图，不能省略任何必填模块。`
      onCorrection('回复未通过完整校验，正在使用相同 schema 纠正一次。', correction)
    }
  }
  throw new Error('结构化回复校验失败')
}
