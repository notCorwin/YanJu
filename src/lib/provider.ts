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
import type { Channel, RequestDiagnostics, Usage } from './types'
import { buildInstructions, compressionInstructions } from './prompts'
import { ChannelRequestError, requestTimeout, requestTrace } from './request-trace'
import type { CompressionInput } from './context'

export function channelFingerprint(channel: Channel) {
  // Bound capability results to exactly this endpoint/key/model, without storing another plaintext key.
  let hash = 2166136261
  for (const char of `${channel.baseUrl}\0${channel.apiKey}\0${channel.model}`)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return `${channel.baseUrl}|${channel.model}|${(hash >>> 0).toString(16)}`
}
export function channelIsReady(channel: Channel) {
  return (
    !!channel.capability?.ok &&
    channel.capability.streaming === true &&
    channel.capability.fingerprint === channelFingerprint(channel)
  )
}
export function validateChannel(channel: Channel) {
  if (!channel.name.trim() || !channel.model.trim() || !channel.apiKey.trim())
    throw new Error('请填写渠道名称、模型和 API Key。')
  const url = new URL(channel.baseUrl)
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Base URL 必须是 HTTP(S) 地址。')
  if (!Number.isFinite(channel.temperature) || channel.temperature < 0 || channel.temperature > 2)
    throw new Error('温度应在 0–2 之间。')
  if (
    channel.requestTimeoutMs !== undefined &&
    (!Number.isInteger(channel.requestTimeoutMs) || channel.requestTimeoutMs < 0)
  )
    throw new Error('请求等待上限须为非负整数；0 表示不限。')
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
  const causes: { name?: unknown; message?: unknown; cause?: unknown }[] = []
  for (
    let current = error;
    current && typeof current === 'object' && !causes.includes(current) && causes.length < 10;
  ) {
    causes.push(current)
    current = 'cause' in current ? current.cause : undefined
  }
  if (
    causes.some(
      (cause) =>
        cause.name === 'TimeoutError' ||
        /\bTimeoutError\b|\b(?:first chunk|chunk|total|step) timeout\b/i.test(
          String(cause.message),
        ),
    )
  )
    return '渠道在等待上限内没有返回内容，收到的部分回复已保留。可调整请求等待上限后重试。'
  if (causes.some((cause) => cause.name === 'AbortError'))
    return '已停止生成，已保留收到的内容，可重试。'
  const cause = error instanceof ChannelRequestError ? error.cause : error
  const status =
    error instanceof ChannelRequestError
      ? error.diagnostics.httpStatus
      : cause && typeof cause === 'object' && 'statusCode' in cause
        ? cause.statusCode
        : undefined
  if (status === 401 || status === 403) return '渠道拒绝授权，请检查 API Key 和模型访问权限。'
  if (status === 429) return '渠道请求受限，请检查用量额度或稍后重试。'
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
  const trace = requestTrace(channel, 'ChannelCapability', fetcher)
  const schema = z.strictObject({ ready: z.boolean(), echo: z.string() })
  const prompt =
    'Return ready=true and echo="YanJu strict output". This tests JSON Schema Structured Outputs.'
  const validate = (value: z.infer<typeof schema>) => {
    if (!value.ready || value.echo !== 'YanJu strict output')
      throw new Error('渠道结构化测试返回内容不符合测试要求。')
  }
  try {
    const result = await generateText({
      model: channelModel(channel, trace.fetch),
      output: Output.object({ schema, name: 'ChannelCapability' }),
      prompt,
      maxOutputTokens: channel.maxOutputTokens,
      temperature: channel.temperature,
      maxRetries: 0,
      abortSignal: signal,
      timeout: requestTimeout(channel, false),
      providerOptions: strictOptions,
    })
    validate(result.output)
    const stream = streamText({
      model: channelModel(channel, trace.fetch),
      output: Output.object({ schema, name: 'ChannelCapability' }),
      prompt,
      maxOutputTokens: channel.maxOutputTokens,
      temperature: channel.temperature,
      maxRetries: 0,
      abortSignal: signal,
      timeout: requestTimeout(channel, true),
      providerOptions: strictOptions,
      onChunk: ({ chunk }) => {
        if (chunk.type === 'text-delta') trace.chunk()
      },
    })
    const outcome = Promise.resolve(stream.output).then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    for await (const partial of stream.partialOutputStream) {
      void partial
    }
    const resolved = await outcome
    if ('error' in resolved) throw resolved.error
    if ((await stream.finishReason) === 'length') throw new Error('渠道流式测试输出被截断。')
    validate(resolved.value)
    return {
      fingerprint: channelFingerprint(channel),
      testedAt: Date.now(),
      ok: true,
      streaming: true,
      firstTokenMs: trace.data.firstTokenMs,
      elapsedMs: trace.finish().elapsedMs,
    }
  } catch (error) {
    throw new ChannelRequestError(error, trace.finish('error'))
  }
}

export async function summarize(
  channel: Channel,
  input: CompressionInput,
  signal: AbortSignal,
  fetcher?: typeof fetch,
) {
  const trace = requestTrace(channel, 'CompressionResult', fetcher)
  let correction = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await generateText({
        model: channelModel(channel, trace.fetch),
        instructions: compressionInstructions,
        prompt: JSON.stringify(input) + correction,
        output: Output.object({ schema: compressionSchema, name: 'CompressionResult' }),
        maxOutputTokens: Math.min(channel.maxOutputTokens, 4096),
        temperature: 0.3,
        providerOptions: strictOptions,
        abortSignal: signal,
        maxRetries: 0,
        timeout: requestTimeout(channel, false),
      })
      if (result.finishReason === 'length')
        throw new Error('摘要被输出上限截断。请增加输出上限后重试压缩。')
      return validateCompression(result.output)
    } catch (error) {
      const invalid =
        error instanceof ContentValidationError ||
        (error instanceof Error &&
          /NoObjectGenerated|NoOutputGenerated|JSONParse|TypeValidation|ZodError/i.test(error.name))
      if (attempt || signal.aborted || !invalid)
        throw new ChannelRequestError(error, trace.finish('error'))
      correction = `\n修正上次结果：${friendlyError(error)}。返回相同 schema 的完整非空摘要。`
    }
  }
  throw new Error('摘要校验失败')
}

export interface GenerationResult {
  reply: Reply
  usage: Usage | undefined
  correction?: string
  diagnostics?: RequestDiagnostics
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
  const trace = requestTrace(
    channel,
    kind === 'narrative' ? 'NarrativeReply' : 'ForumReply',
    options.fetcher,
  )
  let correction: string | undefined
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      let streamError: unknown
      const stream = streamText({
        model: channelModel(channel, trace.fetch),
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
        timeout: requestTimeout(channel, true),
        onChunk: ({ chunk }) => {
          if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') trace.chunk()
        },
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
          diagnostics: trace.finish(finishReason),
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
        trace.data.corrections++
        correction = `上次回复校验失败：${detail}。请纠正并重新输出同一 schema 的完整对象，保留本轮剧情意图，不能省略任何必填模块。`
        onCorrection('回复未通过完整校验，正在使用相同 schema 纠正一次。', correction)
      }
    }
    throw new Error('结构化回复校验失败')
  } catch (error) {
    throw new ChannelRequestError(error, trace.finish('error'))
  }
}

export async function testChannelProtocols(
  channel: Channel,
  signal: AbortSignal,
  onProgress: (detail: string) => void,
  fetcher?: typeof fetch,
) {
  onProgress('正在检查连接、严格结构化与流式传输…')
  const capability = await testChannel(channel, signal, fetcher)
  for (const kind of ['narrative', 'forum'] as const) {
    onProgress(
      kind === 'narrative'
        ? '正在验证完整叙事、状态、手机和日记…'
        : '正在验证论坛与完整 50 条回答…',
    )
    await generateReply({
      channel,
      kind,
      instructions: buildInstructions(undefined, kind),
      messages: [
        { role: 'user', content: '生成符合当前协议的完整测试样例。测试内容不会写入聊天存档。' },
      ],
      signal,
      estimatedInput: 0,
      fetcher,
      onPartial: () => undefined,
      onCorrection: onProgress,
    })
  }
  onProgress('正在验证上下文摘要协议…')
  await summarize(
    channel,
    {
      messages: [{ role: 'user', content: '两人在书房约定明天整理阅读笔记。' }],
      targetTokens: 256,
    },
    signal,
    fetcher,
  )
  return { ...capability, protocols: true }
}
