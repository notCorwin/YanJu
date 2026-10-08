import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenAI } from '@ai-sdk/openai'
import { APICallError, wrapLanguageModel, type DeepPartial, type ModelMessage } from 'ai'
import type { Reply, RequestKind, NarrativeReply, ForumReply } from './schemas'
import type { ApiProtocol, Channel, ChannelCapability, ProtocolCapability, Usage } from './types'
import { channelFingerprint, channelIsReady, protocolLabels } from './channels'
import { responsesLifecycle, ResponseLifecycleError } from './responses'
export { channelFingerprint, channelIsReady } from './channels'
import { compressionInstructions } from './prompts'
import type { CompressionInput } from './context'
import { runStructuredTask } from './task-runner'

export function validateChannel(channel: Channel) {
  if (!channel.name.trim() || !channel.model.trim() || !channel.apiKey.trim())
    throw new Error('请填写渠道名称、模型和 API Key。')
  const url = new URL(channel.baseUrl)
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Base URL 必须是 HTTP(S) 地址。')
  if (!['auto', 'chat-completions', 'responses'].includes(channel.apiMode))
    throw new Error('请选择自动探测、Chat Completions 或 Responses。')
  if (
    channel.temperature !== null &&
    (!Number.isFinite(channel.temperature) || channel.temperature < 0 || channel.temperature > 2)
  )
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
export function channelRequest(channel: Channel, fetcher?: typeof fetch, protocol?: ApiProtocol) {
  validateChannel(channel)
  if (!protocol && channel.apiMode === 'auto' && !channelIsReady(channel))
    throw new Error('自动模式尚未选定可用协议，请先重新测试渠道。')
  const selected =
    protocol ?? (channel.apiMode === 'auto' ? channel.capability!.protocol! : channel.apiMode)
  const settings = {
    baseURL: channel.baseUrl.replace(/\/+$/, ''),
    apiKey: channel.apiKey,
    ...(fetcher ? { fetch: fetcher } : {}),
  }
  if (selected === 'responses') {
    return {
      model: wrapLanguageModel({
        model: createOpenAI(settings).responses(channel.model),
        middleware: responsesLifecycle,
      }),
      providerOptions: { openai: { strictJsonSchema: true, store: false } },
    }
  }
  const provider = createOpenAICompatible({
    name: 'yanju',
    ...settings,
    supportsStructuredOutputs: true,
    includeUsage: true,
  })
  return { model: provider.chatModel(channel.model), providerOptions: strictOptions }
}
export const strictOptions = { yanju: { strictJsonSchema: true } }

export function friendlyError(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError')
    return '已停止生成，已保留收到的内容，可重试。'
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof ResponseLifecycleError) return message
  if (error instanceof DOMException && error.name === 'TimeoutError')
    return '渠道测试超过 45 秒，请检查连接或稍后重新测试。'
  if (/fetch|network|cors/i.test(message))
    return '无法从浏览器连接渠道。请检查 Base URL、网络和服务端 CORS（允许本站来源、Authorization 与 Content-Type 请求头）。'
  if (/temperature/i.test(message))
    return `渠道不接受当前温度配置，请选择「模型默认」后重新测试。${message}`
  if (/json_schema|response_format|text\.format|structured|strict/i.test(message))
    return `渠道未能完成严格结构化请求。请使用支持 json_schema / strict:true 的模型。${message}`
  if (/length|truncat|token limit/i.test(message))
    return '回复达到输出上限而被截断，已保留收到的内容。请提高输出上限后重试。'
  if (APICallError.isInstance(error)) return `${message} 请重新测试渠道后重试。`
  return message
}

async function timedProbe<T>(operation: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal) {
  const controller = new AbortController()
  const cancel = () => controller.abort(new DOMException('已取消', 'AbortError'))
  parent?.addEventListener('abort', cancel, { once: true })
  if (parent?.aborted) cancel()
  const timer = setTimeout(
    () => controller.abort(new DOMException('测试超时', 'TimeoutError')),
    45000,
  )
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason)
    controller.signal.addEventListener('abort', onAbort, { once: true })
    if (controller.signal.aborted) onAbort()
  })
  try {
    return await Promise.race([operation(controller.signal), aborted])
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', cancel)
    controller.signal.removeEventListener('abort', onAbort)
  }
}

export async function testChannel(
  channel: Channel,
  signal?: AbortSignal,
  fetcher?: typeof fetch,
  onProgress?: (detail: string) => void,
): Promise<ChannelCapability> {
  validateChannel(channel)
  const protocols: ApiProtocol[] =
    channel.apiMode === 'auto' ? ['responses', 'chat-completions'] : [channel.apiMode]
  const checks: ChannelCapability['checks'] = {}
  let selected: ApiProtocol | undefined
  for (const protocol of protocols) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    const check: ProtocolCapability = { nonStreaming: 'untested', streaming: 'untested' }
    checks[protocol] = check
    for (const streaming of [false, true]) {
      const stage = streaming ? 'streaming' : 'nonStreaming'
      onProgress?.(
        `正在测试 ${protocolLabels[protocol]} · ${streaming ? '流式' : '非流式'}严格输出…`,
      )
      try {
        await timedProbe(async (abortSignal) => {
          await runStructuredTask({
            kind: 'capability',
            channel,
            protocol,
            streaming,
            allowCorrection: false,
            input: { test: 'nested strict schema' },
            signal: abortSignal,
            fetcher,
            temperature:
              channel.temperature === null ? null : streaming ? channel.temperature : 0.3,
          })
        }, signal)
        check[stage] = 'passed'
      } catch (error) {
        if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
        check[stage] = 'failed'
        check.error = friendlyError(error)
        break
      }
    }
    if (!selected && check.nonStreaming === 'passed' && check.streaming === 'passed')
      selected = protocol
  }
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
  return {
    fingerprint: channelFingerprint(channel),
    testedAt: Date.now(),
    ok: selected !== undefined,
    protocol: selected,
    checks,
    error: selected
      ? undefined
      : protocols.map((p) => `${protocolLabels[p]}：${checks[p]?.error}`).join('；'),
  }
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
    temperature: channel.temperature === null ? null : 0.3,
    streaming: false,
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
