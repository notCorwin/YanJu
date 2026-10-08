import { createProviderModel } from './provider-model'
import { loadModelCatalog } from './model-catalog'
import { APICallError, wrapLanguageModel, type DeepPartial, type ModelMessage } from 'ai'
import type { Reply, RequestKind, NarrativeReply, ForumReply } from './schemas'
import type {
  RequestDiagnostics,
  ApiProtocol,
  Channel,
  ChannelCapability,
  ProtocolCapability,
  Usage,
} from './types'
import { channelFingerprint, channelIsReady, protocolLabels } from './channels'
import { responsesLifecycle, ResponseLifecycleError } from './responses'
export { channelFingerprint, channelIsReady } from './channels'
import { compressionInstructions } from './prompts'
import type { CompressionInput } from './context'
import { ChannelRequestError } from './request-trace'
import { buildInstructions } from './prompts'
import { runStructuredTask } from './task-runner'

export function channelValidationErrors(channel: Channel) {
  const errors: Partial<Record<keyof Channel, string>> = {}
  if (!channel.providerId || !channel.sdk) errors.providerId = '请选择 Models.dev 中的 Provider。'
  if (!channel.apiKey.trim()) errors.apiKey = '请输入渠道提供的 API Key。'
  if (!channel.model.trim()) errors.model = '请选择支持 Structured Outputs 的模型。'
  try {
    if (channel.baseUrl && !channel.baseUrl.includes('${')) {
      const url = new URL(channel.baseUrl, 'http://localhost')
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error()
    }
  } catch {
    errors.baseUrl = '请输入完整的 HTTP(S) 地址，例如 https://example.com/v1。'
  }
  if (!['auto', 'chat-completions', 'responses', 'native'].includes(channel.apiMode))
    errors.apiMode = '请选择自动探测、Chat Completions 或 Responses。'
  if (
    channel.temperature !== null &&
    (!Number.isFinite(channel.temperature) || channel.temperature < 0 || channel.temperature > 2)
  )
    errors.temperature = '温度应在 0–2 之间。'
  if (
    channel.requestTimeoutMs !== undefined &&
    (!Number.isInteger(channel.requestTimeoutMs) || channel.requestTimeoutMs < 0)
  )
    errors.requestTimeoutMs = '请求等待上限须为非负整数；0 表示不限。'
  if (!Number.isInteger(channel.contextWindow) || channel.contextWindow <= 0)
    errors.contextWindow = 'Models.dev 尚未提供有效的上下文容量。'
  return errors
}
export function validateChannel(channel: Channel) {
  const error = Object.values(channelValidationErrors(channel))[0]
  if (error) throw new Error(error)
}
export async function channelRequest(
  channel: Channel,
  fetcher?: typeof fetch,
  protocol?: ApiProtocol,
) {
  validateChannel(channel)
  if (!protocol && channel.apiMode === 'auto' && !channelIsReady(channel))
    throw new Error('自动模式尚未选定可用协议，请先重新测试渠道。')
  const selected =
    protocol ?? (channel.apiMode === 'auto' ? channel.capability!.protocol! : channel.apiMode)
  const model = await createProviderModel(
    await loadModelCatalog(),
    channel.providerId,
    channel.model,
    channel.apiKey,
    fetcher,
    selected,
  )
  return {
    model: model.provider.endsWith('.responses')
      ? wrapLanguageModel({ model, middleware: responsesLifecycle })
      : model,
  }
}

export function friendlyError(error: unknown) {
  if (
    error instanceof DOMException &&
    error.name === 'TimeoutError' &&
    error.message === '测试超时'
  )
    return '渠道测试超过 45 秒，请检查连接或稍后重新测试。'
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
  if (error instanceof ResponseLifecycleError) return message
  if (error instanceof DOMException && error.name === 'TimeoutError')
    return '渠道测试超过 45 秒，请检查连接或稍后重新测试。'
  if (/fetch|network|cors/i.test(message))
    return '无法从浏览器连接渠道。请检查网络和服务商的浏览器访问支持；服务商须通过 CORS 允许本站来源与认证请求头。'
  if (/temperature/i.test(message))
    return `渠道不接受当前温度配置，请选择「模型默认」后重新测试。${message}`
  if (/json_schema|response_format|text\.format|structured|strict/i.test(message))
    return `渠道未能完成严格结构化请求。请使用支持 json_schema / strict:true 的模型。${message}`
  if (/length|truncat|token limit/i.test(message))
    return '回复达到模型自身容量而被截断，已保留收到的内容。可选择容量更大的模型后重试。'
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
  let firstTokenMs: number | undefined
  const startedAt = Date.now()
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
          const result = await runStructuredTask({
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
          if (streaming) firstTokenMs ??= result.diagnostics.firstTokenMs
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
    firstTokenMs,
    elapsedMs: Date.now() - startedAt,
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
  diagnostics: RequestDiagnostics
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
      diagnostics: result.diagnostics,
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
    diagnostics: result.diagnostics,
  }
}

export async function testChannelProtocols(
  channel: Channel,
  signal: AbortSignal,
  onProgress: (detail: string) => void,
  fetcher?: typeof fetch,
) {
  onProgress('正在检查连接、严格结构化与流式传输…')
  const capability = await testChannel(channel, signal, fetcher, onProgress)
  if (!capability.ok) return { ...capability, protocols: false }
  const tested = { ...channel, capability }
  for (const kind of ['narrative', 'forum'] as const) {
    onProgress(
      kind === 'narrative'
        ? '正在验证完整叙事、状态、手机和日记…'
        : '正在验证论坛与完整 50 条回答…',
    )
    await generateReply({
      channel: tested,
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
    tested,
    {
      messages: [{ role: 'user', content: '两人在书房约定明天整理阅读笔记。' }],
      targetTokens: 256,
    },
    signal,
    fetcher,
  )
  return { ...capability, protocols: true }
}
