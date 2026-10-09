import { z } from 'zod'
import type { ModelMessage } from 'ai'
import {
  compressionSchema,
  forumSchema,
  narrativeSchema,
  type CompressionResult,
  type RequestKind,
} from './schemas'
import {
  buildInstructions,
  compressionInstructions,
  modelMessages,
  serializeMessage,
} from './prompts'
import type {
  ApiProtocol,
  Archive,
  Channel,
  Persona,
  StoredMessage,
  Summary,
  StoryContent,
} from './types'
import { estimatedProtocol } from './channels'

export const COMPRESSION_THRESHOLD = 0.85
export const COMPRESSION_TARGET = 0.7
export const RETAIN_TURNS = 4
export const shouldCompact = (inputTokens: number, inputLimit: number) =>
  inputTokens >= inputLimit * COMPRESSION_THRESHOLD

/** A conservative mixed CJK/Latin estimate, calibrated per model from provider usage. */
export function estimateTokens(text: string, ratio = 1) {
  let wide = 0
  for (const c of text) if (c.codePointAt(0)! > 255) wide++
  return Math.ceil((wide * 1.15 + (text.length - wide) / 3) * 1.08 * Math.max(0.5, ratio)) + 16
}
export const requestSchema = (kind: RequestKind) =>
  kind === 'forum' ? forumSchema : narrativeSchema
export const schemaString = (kind: RequestKind) =>
  JSON.stringify(z.toJSONSchema(requestSchema(kind)))
export function serializeRequest(
  channel: Channel,
  instructions: string,
  history: ModelMessage[],
  schema: unknown,
  name: string,
  protocol: ApiProtocol = estimatedProtocol(channel),
) {
  const format = { name, strict: true, schema }
  return JSON.stringify(
    protocol === 'responses'
      ? {
          input: [
            { role: 'system', content: instructions },
            ...history.map((message) => ({
              role: message.role,
              content: [
                {
                  type: message.role === 'assistant' ? 'output_text' : 'input_text',
                  text: message.content,
                },
              ],
            })),
          ],
          text: { format: { type: 'json_schema', ...format } },
          store: false,
        }
      : {
          messages: [{ role: 'system', content: instructions }, ...history],
          response_format: {
            type: 'json_schema',
            json_schema: format,
          },
        },
  )
}
export function contextBudget(
  channel: Channel,
  persona: Persona | undefined,
  kind: RequestKind,
  messages: StoredMessage[],
  summary?: Summary,
  content?: StoryContent,
) {
  const serialized = serializeRequest(
    channel,
    buildInstructions(persona, kind, content),
    modelMessages(messages, summary),
    JSON.parse(schemaString(kind)),
    kind === 'forum' ? 'ForumReply' : 'NarrativeReply',
  )
  const estimated = estimateTokens(serialized, channel.calibration?.ratio)
  return {
    estimated,
    percent: estimated / (channel.inputLimit ?? channel.contextWindow),
    mustCompress: shouldCompact(estimated, channel.inputLimit ?? channel.contextWindow),
  }
}
export function calibrate(channel: Channel, actual: number | undefined, estimated: number) {
  if (!actual || !estimated) return channel.calibration
  const previous = channel.calibration?.ratio ?? 1
  const observed = (actual / estimated) * previous * 1.12
  return {
    ratio: Math.min(4, Math.max(0.5, observed, previous * 0.85)),
    samples: (channel.calibration?.samples ?? 0) + 1,
  }
}

export interface CompressionInput {
  previous?: CompressionResult
  messages: { role: string; content: string }[]
}
export type Summarizer = (
  input: CompressionInput,
  signal: AbortSignal,
) => Promise<CompressionResult>
interface CompressionOptions {
  archive: Archive
  channel: Channel
  persona?: Persona
  kind: RequestKind
  messages: StoredMessage[]
  signal: AbortSignal
  summarize: Summarizer
  commit: (summary: Summary) => Promise<void>
  onProgress?: (detail: string) => void
  force?: boolean
}
const checkAbort = (signal: AbortSignal) => {
  if (signal.aborted) throw new DOMException('已取消', 'AbortError')
}

export async function compactContext(options: CompressionOptions): Promise<Summary | undefined> {
  const { archive, channel, persona, kind, messages, signal, summarize, commit, onProgress } =
    options
  const estimate = (value: string) => estimateTokens(value, channel.calibration?.ratio)
  const valid =
    archive.summary?.revision === archive.revision &&
    messages.some((m) => m.id === archive.summary?.coveredThroughId)
      ? archive.summary
      : undefined
  const before = contextBudget(channel, persona, kind, messages, valid, archive.content)
  if (!options.force && !before.mustCompress) return valid
  checkAbort(signal)
  const userStarts = messages
    .map((m, i) => (m.role === 'user' && !m.stale ? i : -1))
    .filter((i) => i >= 0)
  if (!userStarts.length) return valid
  const completeStarts = userStarts.filter((start, index) =>
    messages
      .slice(start + 1, userStarts[index + 1] ?? messages.length)
      .some((m) => m.role === 'assistant' && m.status === 'complete' && !m.stale),
  )
  let covered = valid ? messages.findIndex((m) => m.id === valid.coveredThroughId) : -1
  let value = valid?.value
  let changed = false
  // A summarizer request has its own bounded budget and does not repeat the character prompt.
  const overhead = estimate(
    serializeRequest(
      channel,
      compressionInstructions,
      [{ role: 'user', content: '' }],
      z.toJSONSchema(compressionSchema),
      'CompressionResult',
    ),
  )
  const batchBudget =
    Math.floor((channel.inputLimit ?? channel.contextWindow) * COMPRESSION_TARGET) - overhead
  if (batchBudget < 256)
    throw new Error('渠道上下文容量不足以执行压缩，请选择上下文容量更大的模型。')

  for (let keep = Math.max(1, Math.min(RETAIN_TURNS, completeStarts.length)); keep >= 1; keep--) {
    const retainedStart = completeStarts.length
      ? completeStarts[Math.max(0, completeStarts.length - keep)]
      : userStarts.at(-1)!
    const end = retainedStart - 1
    if (end <= covered) continue
    const pending = messages
      .slice(covered + 1, end + 1)
      .filter((m) => !m.stale && (m.role === 'user' || m.status === 'complete'))
    let batch: CompressionInput['messages'] = []
    let batchNumber = 0
    const flush = async () => {
      if (!batch.length) return
      checkAbort(signal)
      onProgress?.(`压缩第 ${++batchNumber} 批历史，保留最近 ${keep} 轮完整对话`)
      value = await summarize({ previous: value, messages: batch }, signal)
      checkAbort(signal)
      batch = []
      changed = true
    }
    for (const message of pending) {
      const raw = serializeMessage(message)
      // Split exceptionally large messages. No prefix is committed until every segment succeeds.
      const charBudget = Math.max(
        128,
        Math.floor(
          (batchBudget - estimate(JSON.stringify(value ?? {}))) /
            (1.5 * Math.max(1, channel.calibration?.ratio ?? 1)),
        ),
      )
      const chars = [...raw]
      for (let offset = 0; offset < chars.length; offset += charBudget) {
        const content = chars.slice(offset, offset + charBudget).join('')
        const segment = {
          role: message.role,
          content:
            chars.length > charBudget
              ? `[消息 ${message.id} 分段 ${Math.floor(offset / charBudget) + 1}]\n${content}`
              : content,
        }
        if (
          estimate(JSON.stringify({ previous: value, messages: [...batch, segment] })) > batchBudget
        )
          await flush()
        if (estimate(JSON.stringify({ previous: value, messages: [segment] })) > batchBudget)
          throw new Error('摘要或历史分段仍超出预算，请选择上下文容量更大的模型。原记录未改变。')
        batch.push(segment)
      }
    }
    await flush()
    covered = end
    if (!value) continue
    const candidate: Summary = {
      value,
      coveredThroughId: messages[covered].id,
      coveredCount: covered + 1,
      revision: archive.revision,
      createdAt: Date.now(),
    }
    const after = contextBudget(channel, persona, kind, messages, candidate, archive.content)
    if (after.percent <= COMPRESSION_TARGET || (keep === 1 && !after.mustCompress)) {
      checkAbort(signal)
      await commit(candidate)
      onProgress?.(`上下文已压缩到约 ${Math.round(after.percent * 100)}%，完整聊天记录保留在存档中`)
      return candidate
    }
  }
  if (changed && value && covered >= 0) {
    const candidate: Summary = {
      value,
      coveredThroughId: messages[covered].id,
      coveredCount: covered + 1,
      revision: archive.revision,
      createdAt: Date.now(),
    }
    if (!contextBudget(channel, persona, kind, messages, candidate, archive.content).mustCompress) {
      await commit(candidate)
      return candidate
    }
  }
  throw new Error(
    '角色设定、最新一轮和当前输入已占满上下文。请选择上下文容量更大的模型或缩短当前输入；历史和原摘要均已保留。',
  )
}
