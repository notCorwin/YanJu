import { Output, streamText, type DeepPartial, type ModelMessage } from 'ai'
import { z } from 'zod'
import { channelModel, friendlyError, strictOptions } from './provider'
import { estimateTokens } from './context'
import { taskDefinitions, taskSchemas, validateTask, type TaskKind, type TaskOutput } from './tasks'
import { ContentValidationError, sanitizeSchemaPartial } from './schemas'
import { db } from './db'
import type { Channel, Usage, RequestRecord } from './types'

export interface StructuredOptions<K extends TaskKind> {
  kind: K
  channel: Channel
  archiveId?: string
  ownerId?: string
  input?: unknown
  instructions?: string
  messages?: ModelMessage[]
  signal?: AbortSignal
  estimatedInput?: number
  maxOutputTokens?: number
  temperature?: number
  fetcher?: typeof fetch
  onPartial?: (value: DeepPartial<TaskOutput<K>>, raw: string) => void
  onCorrection?: (detail: string, correction: string) => void
  validate?: (value: TaskOutput<K>) => void
}
export function taskInstructions(kind: TaskKind) {
  return `只返回 ${taskDefinitions[kind].name} 严格根对象，不输出 HTML、XML、脚本或代码块。未知值用 null，无变化列表用 []。\n${taskDefinitions[kind].instructions}`
}
const invalidOutput = (error: unknown) =>
  error instanceof ContentValidationError ||
  (error instanceof Error &&
    /NoObjectGenerated|NoOutputGenerated|JSONParse|TypeValidation|ZodError/i.test(error.name))
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
): Promise<{ value: TaskOutput<K>; usage: Usage | undefined; correction?: string }> {
  const { kind, channel, signal } = options
  const schema = taskSchemas[kind] as unknown as z.ZodType<TaskOutput<K>>
  const instructions = options.instructions ?? taskInstructions(kind)
  const messages = options.messages ?? [
    { role: 'user' as const, content: JSON.stringify(options.input ?? {}) },
  ]
  const maxOutputTokens = options.maxOutputTokens ?? channel.maxOutputTokens
  const executionId = crypto.randomUUID()
  let correction: string | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    const requestMessages: ModelMessage[] = [
      ...messages,
      ...(correction ? [{ role: 'user' as const, content: correction }] : []),
    ]
    const jsonSchema = z.toJSONSchema(schema)
    const estimated = estimateTokens(
      JSON.stringify({
        instructions,
        messages: requestMessages,
        response_format: {
          type: 'json_schema',
          json_schema: { name: taskDefinitions[kind].name, strict: true, schema: jsonSchema },
        },
      }),
      channel.calibration?.ratio,
    )
    if (estimated + maxOutputTokens > channel.contextWindow)
      throw new Error('任务超出渠道上下文预算，请增加容量、缩短输入或先压缩剧情。')
    const record: RequestRecord = {
      id: `${executionId}:${attempt}`,
      archiveId: options.archiveId ?? null,
      ownerId: options.ownerId ?? null,
      kind,
      attempt,
      createdAt: Date.now(),
      channel: {
        id: channel.id,
        name: channel.name,
        baseUrl: channel.baseUrl,
        model: channel.model,
      },
      estimatedInput: estimated,
      status: 'partial',
      request: {
        instructions,
        messages: structuredClone(requestMessages),
        schema: jsonSchema,
        maxOutputTokens,
        temperature: options.temperature ?? channel.temperature,
      },
    }
    await db.requests.put(record)
    let checkpoint = Promise.resolve()
    let lastCheckpoint = 0
    let streamError: unknown
    let usage: Usage | undefined
    const stream = streamText({
      model: channelModel(channel, options.fetcher),
      instructions,
      allowSystemInMessages: true,
      messages: requestMessages,
      output: Output.object({ schema, name: taskDefinitions[kind].name }),
      providerOptions: strictOptions,
      maxOutputTokens,
      temperature: options.temperature ?? channel.temperature,
      abortSignal: signal,
      maxRetries: 0,
      onError: ({ error }) => {
        streamError = error
      },
    })
    const outcome = Promise.resolve(stream.output).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    try {
      for await (const partial of stream.partialOutputStream) {
        if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
        const safe = sanitizeSchemaPartial(schema, partial) as DeepPartial<TaskOutput<K>>
        const raw = JSON.stringify(partial)
        record.partial = safe
        record.raw = raw
        options.onPartial?.(safe, raw)
        if (Date.now() - lastCheckpoint >= 500) {
          lastCheckpoint = Date.now()
          const snapshot = structuredClone(record)
          checkpoint = checkpoint.then(() => db.requests.put(snapshot)).then(() => undefined)
        }
      }
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
      const finish = await stream.finishReason
      usage = measuredUsage(channel, options.estimatedInput ?? estimated, await stream.usage)
      if (finish === 'length') throw new Error('truncated: token limit')
      if (finish === 'content-filter') throw new Error('渠道未完成本次输出。')
      if (streamError) throw streamError
      const resolved = await outcome
      if ('error' in resolved) throw resolved.error
      const value = validateTask(kind, resolved.value)
      options.validate?.(value)
      await checkpoint
      await db.requests.put({ ...record, status: 'complete', output: value, usage })
      return { value, correction, usage }
    } catch (error) {
      const failure = streamError ?? error
      await checkpoint.catch(() => undefined)
      await db.requests.put({
        ...record,
        status: signal?.aborted ? 'cancelled' : 'failed',
        usage,
        error: friendlyError(failure),
      })
      if (signal?.aborted || attempt || !invalidOutput(failure)) throw failure
      correction = `上次回复校验失败：${friendlyError(failure)}。请纠正并重新输出同一 schema 的完整对象，保留本轮意图，不省略必填模块。`
      options.onCorrection?.('回复未通过完整校验，正在使用相同 schema 纠正一次。', correction)
    }
  }
  throw new Error('结构化结果校验失败')
}
