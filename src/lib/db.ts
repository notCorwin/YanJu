import { YanJuDatabase } from './opfs-database'
import { blobToDataUrl } from './file-storage'
import { prepareBackground, readBackground } from './background-storage'
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

export { YanJuDatabase }
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
  await db.mutate(async (tx) => {
    await tx.archives.add(data.archive)
    await tx.messages.add(data.opening)
    await tx.settings.update('app', { activeArchiveId: data.archive.id })
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
  await db.mutate(async (tx) => {
    const archive = await tx.archives.get(message.archiveId)
    if (!archive || (expectedRevision !== undefined && archive.revision !== expectedRevision))
      throw new Error('存档已在其他窗口修改，请重新载入后重试。')
    await tx.messages.put(message)
    const updated = revise(archive)
    if (message.usage) updated.lastUsage = message.usage
    await tx.archives.put(updated)
  })
}
export async function editMessage(id: string, content: string) {
  await db.mutate(async (tx) => {
    const message = await tx.messages.get(id)
    if (!message) throw new Error('消息不存在')
    const archive = await tx.archives.get(message.archiveId)
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
    await tx.messages.put(next)
    const all = await tx.messages.where('archiveId').equals(archive.id).sortBy('sequence')
    const coveredIndex = all.findIndex((m) => m.id === archive.summary?.coveredThroughId)
    await tx.archives.put(
      revise(archive, !!archive.summary && all.findIndex((m) => m.id === id) <= coveredIndex),
    )
  })
}

export async function commitSummary(archiveId: string, revision: number, summary: Summary) {
  await db.mutate(async (tx) => {
    const archive = await tx.archives.get(archiveId)
    if (!archive || archive.revision !== revision)
      throw new Error('压缩期间存档有变更，摘要未提交。')
    await tx.archives.update(archiveId, { summary, compactionError: undefined })
  })
}

const numeric = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)
const record = (v: unknown): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(v)
const list = (v: unknown) => z.array(z.unknown()).parse(v ?? [])

export function normalizeImport(input: unknown): SaveFile {
  const raw = record(input)
  if (raw.version !== 2) throw new Error('仅支持版本 2 的盐焗 JSON 存档。')
  const channels: Channel[] = list(raw.channels).map((value) => {
    const c = record(value)
    return {
      id: str(c.id) || crypto.randomUUID(),
      name: str(c.name, '导入渠道'),
      baseUrl: str(c.baseUrl),
      apiKey: str(c.apiKey),
      model: str(c.model),
      temperature: numeric(c.temperature, 0.9),
      maxOutputTokens: numeric(c.maxOutputTokens, 4096),
      contextWindow: numeric(c.contextWindow, 32768),
      createdAt: numeric(c.createdAt, Date.now()),
      calibration: c.calibration as Channel['calibration'],
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
    }
  })
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
  await database.replace(async (tx) => {
    const background = await prepareBackground(
      data.settings.bgImage,
      database.storage,
      database.root,
    )
    if (background.bgImageRef)
      tx.trackFile(`${database.root}/backgrounds/${background.bgImageRef.id}`)
    await tx.archives.clear()
    await tx.messages.clear()
    await tx.channels.clear()
    await tx.personas.clear()
    await tx.settings.clear()
    await tx.archives.bulkPut(data.archives)
    await tx.messages.bulkPut(data.messages)
    await tx.channels.bulkPut(data.channels)
    await tx.personas.bulkPut(data.masks)
    await tx.settings.put({ ...data.settings, ...background })
  })
  return data
}
export async function exportSave(database = db): Promise<SaveFile> {
  return database.read(async (tx) => {
    const storedSettings = (await tx.settings.get('app')) ?? defaults
    const settings = { ...storedSettings }
    delete settings.bgImageRef
    delete settings.archiveCatalogId
    if (storedSettings.bgImageRef)
      settings.bgImage = await blobToDataUrl(
        await readBackground(storedSettings.bgImageRef, database.storage, database.root),
      )
    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      archives: await tx.archives.toArray(),
      messages: await tx.messages.toArray(),
      channels: await tx.channels.toArray(),
      masks: await tx.personas.toArray(),
      settings,
    }
  })
}

let initializing: Promise<void> | undefined
export function initializeStorage() {
  if (initializing) return initializing
  initializing = (async () => {
    await db.open()
    await db.mutate(async (tx) => {
      if (!(await tx.settings.get('app'))) await tx.settings.put({ ...defaults })
      if (!(await tx.personas.count())) {
        const persona = newPersona()
        await tx.personas.add(persona)
        await tx.settings.update('app', { activePersonaId: persona.id })
      }
      if (!(await tx.archives.count())) {
        const data = createArchiveData()
        await tx.archives.add(data.archive)
        await tx.messages.add(data.opening)
        await tx.settings.update('app', { activeArchiveId: data.archive.id })
      }
      await tx.messages
        .filter((m) => m.status === 'partial')
        .modify({ status: 'cancelled', error: '上次生成已中断，已保留收到的内容，可重试。' })
    })
    await db.cleanup()
  })().finally(() => {
    initializing = undefined
  })
  return initializing
}
