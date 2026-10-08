import { z } from 'zod'
import { compressionSchema, validateForum, validateNarrative } from '../schemas'
import {
  defaults,
  type Archive,
  type Channel,
  type Persona,
  type SaveFile,
  type Settings,
  type StoredMessage,
  type Summary,
} from '../types'
import { db } from './database'
import { serializeSave } from './serialization'

export const exportSave = (database = db) => serializeSave(database)

const numeric = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)
const record = (v: unknown): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(v)
const list = (v: unknown) => z.array(z.unknown()).parse(v ?? [])

export function normalizeImport(input: unknown, restore = false): SaveFile {
  const raw = record(input)
  if (raw.version !== 3) throw new Error('仅支持版本 3 的盐焗 JSON 存档；旧版本不会导入或迁移。')
  const channels: Channel[] = list(raw.channels).map((value) => {
    const c = record(value)
    const apiMode = c.apiMode
    if (typeof apiMode !== 'string' || !['auto', 'chat-completions', 'responses'].includes(apiMode))
      throw new Error('存档包含未知的渠道 API 模式，导入未执行。')
    return {
      id: str(c.id) || crypto.randomUUID(),
      name: str(c.name, '导入渠道'),
      baseUrl: str(c.baseUrl),
      apiKey: str(c.apiKey),
      model: str(c.model),
      apiMode: apiMode as Channel['apiMode'],
      temperature: c.temperature === null ? null : numeric(c.temperature, 0.9),
      maxOutputTokens: numeric(c.maxOutputTokens, 4096),
      contextWindow: numeric(c.contextWindow, 32768),
      createdAt: numeric(c.createdAt, Date.now()),
      calibration: c.calibration as Channel['calibration'],
      capability: restore ? (c.capability as Channel['capability']) : undefined,
    }
  })
  const masks: Persona[] = list(raw.masks).map((value) => {
    const p = record(value)
    return {
      id: str(p.id) || crypto.randomUUID(),
      name: str(p.name, '沈辞玉'),
      gender: str(p.gender),
      identity: str(p.identity),
      prefer: str(p.prefer),
      force: str(p.force),
      createdAt: numeric(p.createdAt, Date.now()),
    }
  })
  const messages: StoredMessage[] = []
  const archives: Archive[] = list(raw.archives).map((value) => {
    const a = record(value)
    const id = str(a.id) || crypto.randomUUID()
    let summary: Summary | undefined
    if (a.summary) {
      const s = record(a.summary)
      summary = {
        value: compressionSchema.parse(s.value),
        coveredThroughId: str(s.coveredThroughId),
        coveredCount: numeric(s.coveredCount, 0),
        revision: numeric(s.revision, 0),
        createdAt: numeric(s.createdAt, Date.now()),
      }
    }
    return {
      id,
      name: str(a.name, '导入存档'),
      createdAt: numeric(a.createdAt, Date.now()),
      updatedAt: numeric(a.updatedAt, Date.now()),
      revision: numeric(a.revision, 0),
      draft: str(a.draft),
      summary,
      lastUsage: a.lastUsage as Archive['lastUsage'],
      compactionError: str(a.compactionError) || undefined,
    }
  })
  list(raw.messages).forEach((value) => {
    const m = record(value)
    if (!archives.some((a) => a.id === m.archiveId))
      throw new Error('存档中存在没有所属篇章的消息。')
    if (!['user', 'assistant'].includes(str(m.role)) || !str(m.id))
      throw new Error('消息字段不完整')
    if (!['narrative', 'forum', 'text', 'notice'].includes(str(m.kind)))
      throw new Error('存档包含不支持的消息类型。')
    if (!['complete', 'partial', 'failed', 'cancelled'].includes(str(m.status)))
      throw new Error('存档包含未知消息状态。')
    let reply: StoredMessage['reply']
    if (m.reply) {
      const r = record(m.reply)
      if (r.kind === 'narrative') reply = { kind: 'narrative', value: validateNarrative(r.value) }
      else if (r.kind === 'forum') reply = { kind: 'forum', value: validateForum(r.value) }
      else throw new Error('未知回复类型')
      if (reply.kind !== m.kind) throw new Error('消息与回复类型不一致。')
    }
    let partial: StoredMessage['partial']
    if (m.partial) {
      const p = record(m.partial)
      if (!['narrative', 'forum'].includes(str(p.kind)) || p.kind !== m.kind)
        throw new Error('消息与部分回复类型不一致。')
      record(p.value)
      partial = { kind: p.kind, value: p.value } as StoredMessage['partial']
    }
    messages.push({
      id: str(m.id),
      archiveId: str(m.archiveId),
      role: m.role as StoredMessage['role'],
      kind: m.kind as StoredMessage['kind'],
      status: m.status as StoredMessage['status'],
      content: str(m.content),
      reply,
      partial,
      rawContent: typeof m.rawContent === 'string' ? m.rawContent : undefined,
      correction:
        m.role === 'assistant' && typeof m.correction === 'string' ? m.correction : undefined,
      error: typeof m.error === 'string' ? m.error : undefined,
      usage: m.usage as StoredMessage['usage'],
      createdAt: numeric(m.createdAt, Date.now()),
      sequence: numeric(m.sequence, messages.length),
    })
  })
  for (const [name, values] of Object.entries({ archives, messages, channels, masks })) {
    if (new Set(values.map((v) => v.id)).size !== values.length)
      throw new Error(`${name} 存在重复 ID，导入未执行。`)
  }
  archives.forEach((a) => {
    if (
      a.summary &&
      (!messages.some((m) => m.archiveId === a.id && m.id === a.summary?.coveredThroughId) ||
        a.summary.revision !== a.revision)
    )
      a.summary = undefined
  })
  const s = raw.settings ? record(raw.settings) : {}
  const settings: Settings = {
    ...defaults,
    id: 'app',
    fontChat: numeric(s.fontChat, defaults.fontChat),
    fontUi: numeric(s.fontUi, defaults.fontUi),
    fontFamily: str(s.fontFamily, defaults.fontFamily),
    bgImage: str(s.bgImage),
    bgOpacity: numeric(s.bgOpacity, defaults.bgOpacity),
    activeChannelId: str(s.activeChannelId, channels[0]?.id ?? ''),
    activePersonaId: str(s.activePersonaId, masks[0]?.id ?? ''),
    activeArchiveId: str(s.activeArchiveId, archives[0]?.id ?? ''),
  }
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
  }
}

export async function importSave(input: unknown, database = db, restore = false) {
  const data = normalizeImport(input, restore)
  await database.transaction(
    'rw',
    database.archives,
    database.messages,
    database.channels,
    database.personas,
    database.settings,
    async () => {
      await Promise.all([
        database.archives.clear(),
        database.messages.clear(),
        database.channels.clear(),
        database.personas.clear(),
      ])
      await database.archives.bulkPut(data.archives)
      await database.messages.bulkPut(data.messages)
      await database.channels.bulkPut(data.channels)
      await database.personas.bulkPut(data.masks)
      await database.settings.put(data.settings)
    },
  )
  return data
}
