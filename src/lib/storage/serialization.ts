import { effectsSchema } from '@/lib/domain-schema'
import {
  calibrationSchema,
  capabilitySchema,
  diagnosticsSchema,
  parseSave,
  usageSchema,
} from '@/lib/save-schema'
import { compressionSchema, validateForum, validateNarrative } from '@/lib/schemas'
import { rebuildStory, type StoryEvent, type StoryState } from '@/lib/story'
import { taskInputSchema, taskSchemas, validateTask, type TaskKind } from '@/lib/tasks'
import type { RequestRecord, TaskRun } from '@/lib/types'
import {
  type Archive,
  type Channel,
  type Persona,
  type SaveFile,
  type StoredMessage,
  type Summary,
} from '@/lib/types'
import { z } from 'zod'

export const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)

export const record = (v: unknown): Record<string, unknown> =>
  z.record(z.string(), z.unknown()).parse(v)

export const list = (v: unknown) => z.array(z.unknown()).parse(v ?? [])

export function normalizeImport(input: unknown, restore = false): SaveFile {
  const raw = record(input)
  if (raw.version !== 3) throw new Error('新版仅支持版本 3 的宴雎 JSON 存档。')
  for (const key of [
    'channels',
    'masks',
    'archives',
    'messages',
    'storyStates',
    'storyEvents',
    'tasks',
    'requests',
  ])
    z.array(z.unknown()).parse(raw[key])
  const channels: Channel[] = list(raw.channels).map((value) => {
    const c = record(value)
    return {
      id: z.string().min(1).parse(c.id),
      name: z.string().parse(c.name),
      providerId: z.string().parse(c.providerId),
      sdk: z.string().parse(c.sdk),
      baseUrl: z.string().parse(c.baseUrl),
      apiKey: z.string().parse(c.apiKey),
      model: z.string().parse(c.model),
      apiMode: z.enum(['auto', 'chat-completions', 'responses', 'native']).parse(c.apiMode),
      temperature: z.number().min(0).max(2).nullable().parse(c.temperature),
      contextWindow: z.number().int().nonnegative().parse(c.contextWindow),
      inputLimit: z.number().int().positive().optional().parse(c.inputLimit),
      temperatureSupported: z.boolean().optional().parse(c.temperatureSupported),
      createdAt: z.number().int().min(0).max(8_640_000_000_000_000).parse(c.createdAt),
      requestTimeoutMs:
        c.requestTimeoutMs === undefined
          ? 300000
          : z.number().int().nonnegative().parse(c.requestTimeoutMs),
      calibration: parseSave(calibrationSchema.optional(), c.calibration),
      capability: restore ? parseSave(capabilitySchema.optional(), c.capability) : undefined,
    }
  })
  const masks: Persona[] = list(raw.masks).map((value) => {
    const p = record(value)
    return {
      id: z.string().min(1).parse(p.id),
      name: z.string().min(1).parse(p.name),
      gender: z.string().parse(p.gender),
      identity: z.string().parse(p.identity),
      prefer: z.string().parse(p.prefer),
      force: z.string().parse(p.force),
      createdAt: z.number().int().min(0).max(8_640_000_000_000_000).parse(p.createdAt),
    }
  })
  const archives: Archive[] = list(raw.archives).map((value) => {
    const a = record(value)
    let summary: Summary | undefined
    if (a.summary) {
      const v = record(a.summary)
      summary = {
        value: compressionSchema.parse(v.value),
        coveredThroughId: z.string().parse(v.coveredThroughId),
        coveredCount: z.number().int().nonnegative().parse(v.coveredCount),
        revision: z.number().int().nonnegative().parse(v.revision),
        createdAt: z.number().parse(v.createdAt),
      }
    }
    return {
      id: z.string().min(1).parse(a.id),
      name: z.string().min(1).parse(a.name),
      createdAt: z.number().int().min(0).max(8_640_000_000_000_000).parse(a.createdAt),
      updatedAt: z.number().int().min(0).max(8_640_000_000_000_000).parse(a.updatedAt),
      revision: z.number().int().nonnegative().parse(a.revision),
      draft: str(a.draft),
      userName: str(a.userName, '沈辞玉'),
      description: str(a.description) || undefined,
      keywords: a.keywords === undefined ? undefined : z.array(z.string()).parse(a.keywords),
      summary,
      lastUsage: parseSave(usageSchema.optional(), a.lastUsage),
      compactionError: str(a.compactionError) || undefined,
    }
  })
  const messages: StoredMessage[] = list(raw.messages).map((value) => {
    const m = record(value)
    if (!archives.some((a) => a.id === m.archiveId)) throw new Error('消息没有所属篇章。')
    if (
      !['user', 'assistant'].includes(str(m.role)) ||
      !['narrative', 'forum', 'notice', 'opening', 'material', 'interaction'].includes(str(m.kind))
    )
      throw new Error('消息类型不完整或不受支持。')
    if (m.reply) {
      const r = record(m.reply)
      if (r.kind === 'narrative') validateNarrative(r.value)
      else if (r.kind === 'forum') validateForum(r.value)
      else throw new Error('未知回复类型')
    }
    if (m.effects) effectsSchema.parse(m.effects)
    if (m.interaction) {
      const interaction = record(m.interaction)
      const fields =
        interaction.kind === 'phone'
          ? ['contactRef', 'speaker', 'time', 'text', 'userText']
          : interaction.kind === 'forum'
            ? ['postId', 'replyTo', 'author', 'time', 'content', 'userText']
            : []
      if (!fields.length || m.kind !== 'interaction') throw new Error('独立交互类型无效')
      fields.forEach((key) => z.string().min(1).parse(interaction[key]))
    } else if (m.kind === 'interaction') throw new Error('独立交互数据缺失')
    return {
      ...m,
      id: z.string().min(1).parse(m.id),
      content: z.string().parse(m.content),
      createdAt: z.number().int().min(0).max(8_640_000_000_000_000).parse(m.createdAt),
      sequence: z.number().int().nonnegative().parse(m.sequence),
      status: z.enum(['complete', 'partial', 'failed', 'cancelled']).parse(m.status),
      stale: m.stale === undefined ? undefined : z.boolean().parse(m.stale),
      requestContext:
        m.requestContext === undefined ? undefined : z.string().parse(m.requestContext),
      usage: parseSave(usageSchema.optional(), m.usage),
      diagnostics: parseSave(diagnosticsSchema.optional(), m.diagnostics),
    } as unknown as StoredMessage
  })
  const tasks: TaskRun[] = list(raw.tasks).map((value) => {
    const t = record(value)
    if (
      !archives.some((a) => a.id === t.archiveId) ||
      !Object.hasOwn(taskSchemas, str(t.kind)) ||
      ['narrative', 'forum', 'compression', 'capability'].includes(str(t.kind))
    )
      throw new Error('任务类型或篇章无效')
    if (t.status === 'complete') validateTask(t.kind as TaskKind, t.output)
    taskInputSchema.parse(t.input)
    z.string().min(1).parse(t.channelId)
    if (t.applied !== undefined) z.boolean().parse(t.applied)
    return {
      ...t,
      id: z.string().min(1).parse(t.id),
      createdAt: z.number().int().min(0).max(8_640_000_000_000_000).parse(t.createdAt),
      revision: z.number().int().nonnegative().parse(t.revision),
      usage: parseSave(usageSchema.optional(), t.usage),
      diagnostics: parseSave(diagnosticsSchema.optional(), t.diagnostics),
      status: z.enum(['complete', 'partial', 'failed', 'cancelled']).parse(t.status),
    } as unknown as TaskRun
  })
  const requests: RequestRecord[] = list(raw.requests).map((value) => {
    const r = record(value)
    const request = record(r.request)
    if (!Object.hasOwn(taskSchemas, str(r.kind))) throw new Error('未知请求类型')
    if (r.status === 'complete') validateTask(r.kind as TaskKind, r.output)
    if (r.archiveId !== null && !archives.some((a) => a.id === r.archiveId))
      throw new Error('请求的篇章不存在')
    z.string().nullable().parse(r.archiveId)
    z.string().nullable().parse(r.ownerId)
    z.string().parse(request.instructions)
    z.array(
      z.object({ role: z.enum(['system', 'user', 'assistant', 'tool']), content: z.unknown() }),
    ).parse(request.messages)
    z.number().min(0).max(2).nullable().parse(request.temperature)
    z.boolean().parse(request.streaming)
    z.object({
      id: z.string(),
      name: z.string(),
      baseUrl: z.string(),
      model: z.string(),
      protocol: z.enum(['responses', 'chat-completions', 'native']),
    }).parse(r.channel)
    return {
      ...r,
      id: z.string().min(1).parse(r.id),
      createdAt: z.number().int().min(0).max(8_640_000_000_000_000).parse(r.createdAt),
      estimatedInput: z.number().nonnegative().parse(r.estimatedInput),
      attempt: z.number().int().min(0).max(1).parse(r.attempt),
      usage: parseSave(usageSchema.optional(), r.usage),
      diagnostics: parseSave(diagnosticsSchema.optional(), r.diagnostics),
      status: z.enum(['complete', 'partial', 'failed', 'cancelled']).parse(r.status),
    } as unknown as RequestRecord
  })
  for (const [name, values] of Object.entries({
    archives,
    messages,
    channels,
    masks,
    tasks,
    requests,
  }))
    if (new Set(values.map((v) => v.id)).size !== values.length)
      throw new Error(`${name} 存在重复 ID，导入未执行。`)
  const storyStates: StoryState[] = []
  const storyEvents: StoryEvent[] = []
  for (const a of archives) {
    const history = messages.filter((m) => m.archiveId === a.id)
    if (new Set(history.map((m) => m.sequence)).size !== history.length)
      throw new Error('篇章消息序号重复')
    if (
      a.summary &&
      (!history.some((m) => m.id === a.summary?.coveredThroughId && !m.stale) ||
        a.summary.revision !== a.revision)
    )
      a.summary = undefined
    const projection = rebuildStory(a, history)
    storyStates.push(projection.story)
    storyEvents.push(...projection.events)
  }
  const settings = z
    .object({
      id: z.literal('app'),
      activeChannelId: z.string(),
      activePersonaId: z.string(),
      activeArchiveId: z.string(),
      migrated: z.boolean(),
      autoMusic: z.boolean(),
      fontChat: z.number().min(10).max(40),
      fontUi: z.number().min(10).max(24),
      fontFamily: z.string(),
      bgImage: z.string(),
      bgOpacity: z.number().min(0).max(100),
    })
    .parse({ ...record(raw.settings), id: 'app', migrated: true })
  if (!channels.some((c) => c.id === settings.activeChannelId))
    settings.activeChannelId = channels[0]?.id ?? ''
  if (!masks.some((p) => p.id === settings.activePersonaId))
    settings.activePersonaId = masks[0]?.id ?? ''
  if (!archives.some((a) => a.id === settings.activeArchiveId))
    settings.activeArchiveId = archives[0]?.id ?? ''
  return {
    version: 3,
    exportedAt: new Date().toISOString(),
    channels,
    masks,
    archives,
    messages,
    settings,
    storyStates,
    storyEvents,
    tasks,
    requests,
  }
}
