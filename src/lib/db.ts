import Dexie, { type Table } from 'dexie'
import opening from '@/content/opening.txt?raw'
import { convertLegacy } from './legacy'
import {
  defaults,
  newPersona,
  type Archive,
  type Channel,
  type Persona,
  type Settings,
  type StoredMessage,
  type Summary,
  type SaveFile,
} from './types'
import { validateNarrative, validateForum, compressionSchema } from './schemas'
import { z } from 'zod'

export class YanJuDatabase extends Dexie {
  archives!: Table<Archive, string>
  messages!: Table<StoredMessage, string>
  channels!: Table<Channel, string>
  personas!: Table<Persona, string>
  settings!: Table<Settings, string>
  constructor(name = 'yanju-v2') {
    super(name)
    this.version(1).stores({
      archives: 'id,updatedAt',
      messages: 'id,archiveId,[archiveId+sequence]',
      channels: 'id,createdAt',
      personas: 'id,createdAt',
      settings: 'id',
    })
  }
}
export const db = new YanJuDatabase()
export const archiveMessages = (id: string, database = db) =>
  database.messages.where('archiveId').equals(id).sortBy('sequence')

export function createArchiveData(name = '新的篇章'): { archive: Archive; opening: StoredMessage } {
  const now = Date.now()
  const id = crypto.randomUUID()
  const archive: Archive = { id, name, createdAt: now, updatedAt: now, revision: 0, draft: '' }
  const msg: StoredMessage = {
    id: crypto.randomUUID(),
    archiveId: id,
    role: 'assistant',
    content: opening,
    legacy: { body: opening, panels: [] },
    kind: 'legacy',
    status: 'complete',
    createdAt: now,
    sequence: 0,
  }
  return { archive, opening: msg }
}
export async function createArchive(name?: string) {
  const data = createArchiveData(name)
  await db.transaction('rw', db.archives, db.messages, db.settings, async () => {
    await db.archives.add(data.archive)
    await db.messages.add(data.opening)
    await db.settings.update('app', { activeArchiveId: data.archive.id })
  })
  return data.archive
}

/** Appends preserve a summary's coverage; edits to its covered prefix invalidate it. */
export function revise(archive: Archive, invalidate = false): Archive {
  const revision = archive.revision + 1
  return {
    ...archive,
    revision,
    updatedAt: Date.now(),
    lastUsage: undefined,
    summary: invalidate ? undefined : archive.summary && { ...archive.summary, revision },
    compactionError: undefined,
  }
}
export async function appendMessage(message: StoredMessage, expectedRevision?: number) {
  await db.transaction('rw', db.archives, db.messages, async () => {
    const archive = await db.archives.get(message.archiveId)
    if (!archive || (expectedRevision !== undefined && archive.revision !== expectedRevision))
      throw new Error('存档已在其他窗口修改，请重新载入后重试。')
    await db.messages.put(message)
    const updated = revise(archive)
    if (message.usage) updated.lastUsage = message.usage
    await db.archives.put(updated)
  })
}
export async function editMessage(id: string, content: string) {
  await db.transaction('rw', db.archives, db.messages, async () => {
    const message = await db.messages.get(id)
    if (!message) throw new Error('消息不存在')
    const archive = await db.archives.get(message.archiveId)
    if (!archive) throw new Error('存档不存在')
    let next: StoredMessage = {
      ...message,
      content,
      rawContent: undefined,
      partial: undefined,
      error: undefined,
      status: 'complete',
    }
    if (message.role === 'assistant' && message.reply) {
      const parsed: unknown = JSON.parse(content)
      next = {
        ...next,
        reply:
          message.reply.kind === 'narrative'
            ? { kind: 'narrative', value: validateNarrative(parsed) }
            : { kind: 'forum', value: validateForum(parsed) },
      }
    } else if (message.role === 'assistant')
      next = { ...next, kind: 'legacy', legacy: convertLegacy(content) }
    await db.messages.put(next)
    const all = await archiveMessages(archive.id)
    const coveredIndex = all.findIndex((m) => m.id === archive.summary?.coveredThroughId)
    await db.archives.put(
      revise(archive, !!archive.summary && all.findIndex((m) => m.id === id) <= coveredIndex),
    )
  })
}

export async function commitSummary(archiveId: string, revision: number, summary: Summary) {
  await db.transaction('rw', db.archives, async () => {
    const archive = await db.archives.get(archiveId)
    if (!archive || archive.revision !== revision)
      throw new Error('压缩期间存档有变更，摘要未提交。')
    await db.archives.update(archiveId, { summary, compactionError: undefined })
  })
}

const numeric = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)
const record = (v: unknown): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(v)
const list = (v: unknown) => z.array(z.unknown()).parse(v ?? [])

export function normalizeImport(input: unknown): SaveFile {
  const raw = record(input)
  if (raw.version !== 1 && raw.version !== 2)
    throw new Error('仅支持版本 1 和版本 2 的盐焗 JSON 存档。')
  const channels: Channel[] = list(raw.channels).map((value) => {
    const c = record(value)
    return {
      id: str(c.id) || crypto.randomUUID(),
      name: str(c.name, '导入渠道'),
      baseUrl: str(c.baseUrl),
      apiKey: str(c.apiKey),
      model: str(c.model),
      temperature: numeric(c.temperature, 0.9),
      maxOutputTokens: numeric(c.maxOutputTokens ?? c.maxTokens, 4096),
      contextWindow: numeric(c.contextWindow, 32768),
      createdAt: numeric(c.createdAt, Date.now()),
      calibration: raw.version === 2 ? (c.calibration as Channel['calibration']) : undefined,
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
    if (raw.version === 1) {
      list(a.messages).forEach((value, sequence) => {
        const m = record(value)
        const content = str(m.content)
        const original = str(m.rawContent, content)
        messages.push({
          id: str(m.id) || crypto.randomUUID(),
          archiveId: id,
          role: m.role === 'user' ? 'user' : 'assistant',
          content,
          rawContent: original,
          kind:
            m.role === 'user'
              ? /^(\$发送帖子|新帖[：:]|回复.+[：:])/.test(content)
                ? 'forum'
                : 'narrative'
              : 'legacy',
          legacy: m.role === 'user' ? undefined : convertLegacy(original),
          createdAt: numeric(
            m.createdAt ?? m.timestamp,
            numeric(a.createdAt, Date.now()) + sequence,
          ),
          sequence,
          status: 'complete',
        })
      })
    }
    let summary: Summary | undefined
    if (raw.version === 2 && a.summary) {
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
    }
  })
  if (raw.version === 2) {
    list(raw.messages).forEach((value) => {
      const m = record(value)
      if (!archives.some((a) => a.id === m.archiveId))
        throw new Error('存档中存在没有所属篇章的消息。')
      if (m.reply) {
        const r = record(m.reply)
        if (r.kind === 'narrative') validateNarrative(r.value)
        else if (r.kind === 'forum') validateForum(r.value)
        else throw new Error('未知回复类型')
      }
      if (!['user', 'assistant'].includes(str(m.role)) || !str(m.id))
        throw new Error('消息字段不完整')
      messages.push({
        ...m,
        content: str(m.content),
        createdAt: numeric(m.createdAt, Date.now()),
        sequence: numeric(m.sequence, messages.length),
        status: ['complete', 'partial', 'failed', 'cancelled'].includes(str(m.status))
          ? m.status
          : 'complete',
      } as unknown as StoredMessage)
    })
  }
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
    migrated: true,
  }
  if (!channels.some((c) => c.id === settings.activeChannelId))
    settings.activeChannelId = channels[0]?.id ?? ''
  if (!masks.some((p) => p.id === settings.activePersonaId))
    settings.activePersonaId = masks[0]?.id ?? ''
  if (!archives.some((a) => a.id === settings.activeArchiveId))
    settings.activeArchiveId = archives[0]?.id ?? ''
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    channels,
    masks,
    archives,
    messages,
    settings,
  }
}

export async function importSave(input: unknown, database = db) {
  const data = normalizeImport(input)
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
export async function exportSave(database = db): Promise<SaveFile> {
  return database.transaction(
    'r',
    database.archives,
    database.messages,
    database.channels,
    database.personas,
    database.settings,
    async () => ({
      version: 2,
      exportedAt: new Date().toISOString(),
      archives: await database.archives.toArray(),
      messages: await database.messages.toArray(),
      channels: await database.channels.toArray(),
      masks: await database.personas.toArray(),
      settings: (await database.settings.get('app')) ?? defaults,
    }),
  )
}

let initializing: Promise<void> | undefined
export function initializeStorage() {
  if (initializing) return initializing
  initializing = (async () => {
    await db.open()
    if (!(await db.settings.get('app'))) {
      const get = (key: string, fallback: unknown) => {
        const value = localStorage.getItem(`yanju_${key}`)
        if (!value) return fallback
        try {
          return JSON.parse(value) as unknown
        } catch {
          return value
        }
      }
      if (['archives', 'channels', 'masks'].some((k) => localStorage.getItem(`yanju_${k}`))) {
        const data = normalizeImport({
          version: 1,
          archives: get('archives', []),
          channels: get('channels', []),
          masks: get('masks', []),
          settings: get('settings', {}),
        })
        data.settings.activeArchiveId = str(get('archive_cur', data.settings.activeArchiveId))
        data.settings.activeChannelId = str(get('channel_cur', data.settings.activeChannelId))
        data.settings.activePersonaId = str(get('mask_cur', data.settings.activePersonaId))
        await importSave(data)
      } else await db.settings.put({ ...defaults, migrated: true })
    }
    if (!(await db.personas.count())) {
      const persona = newPersona()
      await db.personas.add(persona)
      await db.settings.update('app', { activePersonaId: persona.id })
    }
    if (!(await db.archives.count())) await createArchive()
    await db.messages
      .filter((m) => m.status === 'partial')
      .modify({ status: 'cancelled', error: '上次生成已中断，已保留收到的内容，可重试。' })
  })().catch((error) => {
    initializing = undefined
    throw error
  })
  return initializing
}
