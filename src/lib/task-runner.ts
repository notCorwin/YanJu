import { generateText, parsePartialJson, streamText, type DeepPartial, type ModelMessage } from 'ai'
import { z } from 'zod'
import type { JSONObject } from '@ai-sdk/provider'
import { loadModelCatalog, catalogSelection, type ModelCatalog } from './model-catalog'
import { estimatedProtocol, outputModeLabels } from './channels'
import { estimateTokens, serializeRequest } from './context'
import { channelRequest, friendlyError } from './provider'
import { ChannelRequestError, requestTrace } from './request-trace'
import { sanitizeSchemaPartial } from './schemas'
import { repairJsonOutput, unsupportedOutputFormat, validationDetails } from './json-output'
import { saveRequestRecord } from './storage'
import { taskDefinitions, taskSchemas, validateTask, type TaskKind, type TaskOutput } from './tasks'
import {
  outputModes,
  type OutputMode,
  type ApiProtocol,
  type Channel,
  type RequestDiagnostics,
  type RequestRecord,
  type Usage,
} from './types'

export interface StructuredOptions<K extends TaskKind> {
  kind: K
  catalog?: ModelCatalog
  channel: Channel
  archiveId?: string
  ownerId?: string
  input?: unknown
  instructions?: string
  messages?: ModelMessage[]
  signal?: AbortSignal
  estimatedInput?: number
  temperature?: number | null
  protocol?: ApiProtocol
  streaming?: boolean
  allowCorrection?: boolean
  fetcher?: typeof fetch
  onPartial?: (value: DeepPartial<TaskOutput<K>>, raw: string) => void
  onCorrection?: (detail: string, correction: string) => void
  validate?: (value: TaskOutput<K>) => void
}
export function taskInstructions(kind: TaskKind) {
  return `只返回 ${taskDefinitions[kind].name} JSON 根对象，不输出 HTML、XML、脚本或代码块。未知值用 null，无变化列表用 []。\n${taskDefinitions[kind].instructions}`
}
function measuredUsage(
  channel: Channel,
  estimated: number,
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined,
): Usage | undefined {
  return usage?.inputTokens === undefined
    ? undefined
    : {
        input: usage.inputTokens,
        output: usage.outputTokens ?? 0,
        total: usage.totalTokens ?? usage.inputTokens + (usage.outputTokens ?? 0),
        measuredAt: Date.now(),
        estimatedInput: estimated,
        channelId: channel.id,
      }
}
export async function runStructuredTask<K extends TaskKind>(
  options: StructuredOptions<K>,
): Promise<{
  value: TaskOutput<K>
  usage: Usage | undefined
  correction?: string
  diagnostics: RequestDiagnostics
}> {
  const { kind, channel, signal } = options
  const schema = taskSchemas[kind] as unknown as z.ZodType<TaskOutput<K>>
  const jsonSchema = z.toJSONSchema(schema)
  const baseInstructions = options.instructions ?? taskInstructions(kind)
  const messages = options.messages ?? [
    { role: 'user' as const, content: JSON.stringify(options.input ?? {}) },
  ]
  const temperature = options.temperature === undefined ? channel.temperature : options.temperature
  const protocol = options.protocol ?? estimatedProtocol(channel)
  const streaming = options.streaming !== false
  const executionId = crypto.randomUUID()
  const trace = requestTrace(channel, taskDefinitions[kind].name, options.fetcher)
  let catalog: ModelCatalog
  try {
    catalog = options.catalog ?? (await loadModelCatalog(false, signal))
    signal?.throwIfAborted()
  } catch (error) {
    throw new ChannelRequestError(error, trace.finish(signal?.aborted ? 'cancelled' : 'error'))
  }
  const selected = catalogSelection(channel, catalog)
  const checked = channel.capability?.checks?.[protocol]
  const provenMode =
    kind === 'capability'
      ? undefined
      : streaming
        ? checked?.streamingOutputMode
        : checked?.outputMode
  let mode: OutputMode =
    provenMode ?? (selected.model.structured_output === false ? 'json' : 'structured')
  let correction: string | undefined
  let corrections = 0
  let attempt = 0
  const validate = (input: unknown) => {
    const value = validateTask(kind, input)
    options.validate?.(value)
    return value
  }
  for (;;) {
    signal?.throwIfAborted()
    trace.data.corrections = corrections
    trace.data.outputMode = mode
    const instructions =
      mode === 'structured'
        ? baseInstructions
        : `${baseInstructions}\n只回复一个 JSON 根对象，必须符合以下 JSON Schema，所有 required 字段都必须填写，不要省略任何模块：\n${JSON.stringify(jsonSchema)}`
    const requestMessages: ModelMessage[] = [
      ...messages,
      ...(correction ? [{ role: 'user' as const, content: correction }] : []),
    ]
    const estimated = estimateTokens(
      serializeRequest(
        channel,
        instructions,
        requestMessages,
        jsonSchema,
        taskDefinitions[kind].name,
        protocol,
      ),
      channel.calibration?.ratio,
    )
    if (estimated > (channel.inputLimit ?? channel.contextWindow))
      throw new ChannelRequestError(
        new Error('任务超出渠道上下文预算，请选择容量更大的模型、缩短输入或先压缩剧情。'),
        trace.finish('error'),
      )
    const record: RequestRecord = {
      id: `${executionId}:${attempt}`,
      archiveId: options.archiveId ?? null,
      ownerId: options.ownerId ?? null,
      kind,
      attempt: attempt++,
      createdAt: Date.now(),
      channel: {
        id: channel.id,
        name: channel.name,
        baseUrl: channel.baseUrl || selected.api || '',
        model: channel.model,
        protocol,
      },
      estimatedInput: estimated,
      status: 'partial',
      request: {
        instructions,
        messages: structuredClone(requestMessages),
        schema: jsonSchema,
        temperature,
        streaming,
        outputMode: mode,
      },
    }
    await saveRequestRecord(record)
    let checkpoint = Promise.resolve()
    let lastCheckpoint = 0
    let streamError: unknown
    let usage: Usage | undefined
    let raw = ''
    let validationError: unknown
    try {
      const request = {
        ...(await channelRequest(
          channel,
          trace.fetch,
          protocol,
          signal,
          kind === 'capability' ? catalog : undefined,
          {
            outputMode: mode,
            schema: jsonSchema as JSONObject,
            schemaName: taskDefinitions[kind].name,
          },
        )),
        instructions,
        allowSystemInMessages: true,
        messages: requestMessages,
        ...(temperature === null ? {} : { temperature }),
        abortSignal: signal,
        maxRetries: 0,
      }
      let finishReason: string
      if (!streaming) {
        const result = await generateText(request)
        trace.chunk()
        raw = result.text
        finishReason = result.finishReason
        usage = measuredUsage(channel, options.estimatedInput ?? estimated, result.usage)
      } else {
        const stream = streamText({
          ...request,
          onChunk: ({ chunk }) => {
            if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
              trace.chunk()
            }
          },
          onError: ({ error }) => {
            streamError = error
          },
        })
        for await (const delta of stream.textStream) {
          signal?.throwIfAborted()
          raw += delta
          const parsed = await parsePartialJson(raw)
          if (parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
            const safe = sanitizeSchemaPartial(schema, parsed.value) as DeepPartial<TaskOutput<K>>
            record.partial = safe
            record.raw = raw
            options.onPartial?.(safe, raw)
            if (Date.now() - lastCheckpoint >= 500) {
              lastCheckpoint = Date.now()
              const snapshot = structuredClone(record)
              checkpoint = checkpoint.then(() => saveRequestRecord(snapshot))
            }
          }
        }
        finishReason = await stream.finishReason
        usage = measuredUsage(channel, options.estimatedInput ?? estimated, await stream.usage)
        if (streamError) throw streamError
      }
      signal?.throwIfAborted()
      record.raw = raw
      if (finishReason === 'length') throw new Error('truncated: token limit')
      if (finishReason === 'content-filter') throw new Error('渠道未完成本次输出。')
      let value: TaskOutput<K>
      try {
        value = validate(JSON.parse(raw))
      } catch (error) {
        validationError = error
        try {
          value = validate(repairJsonOutput(raw, jsonSchema))
          trace.data.repairs = (trace.data.repairs ?? 0) + 1
          options.onCorrection?.('JSON 已在本地修复并通过完整校验。', correction ?? '')
        } catch (repairError) {
          // Prefer the repaired object's field paths when syntax repair succeeds but content is incomplete.
          if (!(repairError instanceof SyntaxError)) validationError = repairError
          throw validationError
        }
      }
      signal?.throwIfAborted()
      await checkpoint
      const diagnostics = trace.finish(finishReason)
      await saveRequestRecord({ ...record, status: 'complete', output: value, usage, diagnostics })
      return { value, correction, usage, diagnostics }
    } catch (error) {
      const failure = streamError ?? error
      await checkpoint.catch(() => undefined)
      await saveRequestRecord({
        ...record,
        raw: raw || record.raw,
        status: signal?.aborted ? 'cancelled' : 'failed',
        usage,
        error: friendlyError(failure),
        diagnostics: trace.finish(signal?.aborted ? 'cancelled' : 'error'),
      })
      if (!signal?.aborted && mode !== 'prompt' && unsupportedOutputFormat(failure)) {
        mode = outputModes[outputModes.indexOf(mode) + 1]
        trace.data.fallbacks = (trace.data.fallbacks ?? 0) + 1
        options.onCorrection?.(
          `端点不支持当前输出格式，正在回退到 ${outputModeLabels[mode]}。`,
          correction ?? '',
        )
        continue
      }
      if (
        !signal?.aborted &&
        validationError &&
        options.allowCorrection !== false &&
        corrections < 1
      ) {
        corrections++
        const detail = validationDetails(validationError)
        correction = `${correction ? `${correction}\n` : ''}上次回复校验失败：${detail}。请重新生成本轮完整 JSON 对象，不要遗漏上述字段，纠正类型、条数与内容约束。保持本轮意图，必须符合相同 JSON Schema。`
        options.onCorrection?.('本地修复后仍未通过校验，正在加入具体约束重新生成。', correction)
        continue
      }
      throw new ChannelRequestError(failure, trace.finish(signal?.aborted ? 'cancelled' : 'error'))
    }
  }
}
