import Dexie, { type Table } from 'dexie'
import opening from '@/content/opening.txt?raw'
import { convertLegacy } from './legacy'
import {
  defaults,
  newPersona,
  type Archive,
  type Channel,
  type ChannelCapability,
  type Persona,
  type Settings,
  type StoredMessage,
  type Summary,
  type SaveFile,
} from './types'
import { validateNarrative, validateForum, compressionSchema } from './schemas'
import { z } from 'zod'
import { channelFingerprint, withCapability } from './channels'
import { OpfsPersistence, type PersistenceSnapshot } from './opfs'
import {
  calibrationSchema,
  capabilitySchema,
  parseSave,
  saveFileSchema,
  storedMessageSchema,
  usageSchema,
} from './save-schema'
import { activeArchiveOperations, withImportOperation, type OperationLease } from './operations'

interface PersistenceChange {
  id: string
  token: string
}

export class YanJuDatabase extends Dexie {
  archives!: Table<Archive, string>
  messages!: Table<StoredMessage, string>
  channels!: Table<Channel, string>
  personas!: Table<Persona, string>
  settings!: Table<Settings, string>
  operations!: Table<OperationLease, string>
  persistenceChanges!: Table<PersistenceChange, string>
  readonly persistence: OpfsPersistence
  constructor(name = 'yanju-v2') {
    super(name)
    this.persistence = new OpfsPersistence(name, (ids) => readPersistenceSnapshot(this, ids), true)
    this.version(1).stores({
      archives: 'id,updatedAt',
      messages: 'id,archiveId,[archiveId+sequence]',
      channels: 'id,createdAt',
      personas: 'id,createdAt',
      settings: 'id',
    })
    this.version(2).stores({ operations: 'archiveId' })
    this.version(3).stores({ persistenceChanges: 'id' })
    const changes = new WeakMap<object, { touched: boolean; full: boolean; ids: Set<string> }>()
    this.use({
      stack: 'dbcore',
      name: 'opfs-persistence',
      create: (core) => ({
        ...core,
        transaction: (stores, mode, options) => {
          const tracked =
            mode === 'readwrite' &&
            stores.some((name) => name !== 'operations' && name !== 'persistenceChanges')
          const transaction = core.transaction(
            tracked ? [...new Set([...stores, 'persistenceChanges'])] : stores,
            mode,
            options,
          )
          if (mode === 'readwrite') {
            const change = { touched: false, full: false, ids: new Set<string>() }
            changes.set(transaction, change)
            ;(transaction as IDBTransaction).addEventListener('complete', () => {
              if (change.touched)
                this.persistence.markDirty(change.full ? undefined : [...change.ids])
            })
          }
          return transaction
        },
        table: (name) => {
          const table = core.table(name)
          return {
            ...table,
            mutate: (request) =>
              table.mutate(request).then(async (result) => {
                const change = changes.get(request.trans)
                if (!change || name === 'operations' || name === 'persistenceChanges') return result
                change.touched = true
                const journal = ['metadata']
                if (name === 'messages') {
                  if (request.type === 'deleteRange') {
                    change.full = true
                    journal.push('all')
                  } else {
                    const keys = request.keys ?? result.results
                    if (keys)
                      keys.forEach((key, index) => {
                        if (!result.failures[index] && typeof key === 'string') {
                          change.ids.add(key)
                          journal.push(`message:${key}`)
                        }
                      })
                    else {
                      change.full = true
                      journal.push('all')
                    }
                  }
                }
                // The journal commits in the same transaction. Any tab can finish syncing a tab that closed.
                const written = await core.table('persistenceChanges').mutate({
                  trans: request.trans,
                  type: 'put',
                  values: journal.map((id) => ({ id, token: crypto.randomUUID() })),
                })
                if (written.numFailures) throw new Error('未能记录存档同步状态。')
                return result
              }),
          }
        },
      }),
    })
  }
}
export const db = new YanJuDatabase()
export const archiveMessages = (id: string, database = db) =>
  database.messages
    .where('[archiveId+sequence]')
    .between([id, Dexie.minKey], [id, Dexie.maxKey])
    .toArray()

export async function recentArchiveMessages(id: string, limit: number, database = db) {
  const collection = database.messages
    .where('[archiveId+sequence]')
    .between([id, Dexie.minKey], [id, Dexie.maxKey])
  const [count, messages] = await Promise.all([
    collection.count(),
    collection.clone().reverse().limit(limit).toArray(),
  ])
  return { count, messages: messages.reverse() }
}

export async function contextArchiveMessages(archive: Archive, database = db) {
  const boundary =
    archive.summary?.revision === archive.revision
      ? await database.messages.get(archive.summary.coveredThroughId)
      : undefined
  if (!boundary || boundary.archiveId !== archive.id) return archiveMessages(archive.id, database)
  return database.messages
    .where('[archiveId+sequence]')
    .between([archive.id, boundary.sequence], [archive.id, Dexie.maxKey])
    .toArray()
}

/** Probes finish asynchronously; commit only if their request configuration is still current. */
export async function commitChannelCapability(
  tested: Channel,
  capability: ChannelCapability,
  database = db,
): Promise<Channel | undefined> {
  return database.transaction('rw', database.channels, async () => {
    const current = await database.channels.get(tested.id)
    if (!current || channelFingerprint(current) !== channelFingerprint(tested)) return undefined
    const next = withCapability(current, capability)
    await database.channels.update(current.id, {
      capability: next.capability,
      calibration: next.calibration,
    })
    return next
  })
}

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
export async function createArchive(name?: string, database = db) {
  const data = createArchiveData(name)
  await database.transaction(
    'rw',
    database.archives,
    database.messages,
    database.settings,
    async () => {
      await database.archives.add(data.archive)
      await database.messages.add(data.opening)
      await database.settings.update('app', { activeArchiveId: data.archive.id })
    },
  )
  return data.archive
}

export function copyArchiveData(source: Archive, messages: StoredMessage[], name: string) {
  const id = crypto.randomUUID()
  const ids = new Map(messages.map((message) => [message.id, crypto.randomUUID()]))
  const covered = source.summary && ids.get(source.summary.coveredThroughId)
  const archive: Archive = {
    ...source,
    id,
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 0,
    draft: '',
    compactionError: undefined,
    summary:
      covered && source.summary?.revision === source.revision
        ? { ...source.summary, coveredThroughId: covered, revision: 0 }
        : undefined,
  }
  return {
    archive,
    messages: messages.map((message, sequence) => ({
      ...message,
      id: ids.get(message.id)!,
      archiveId: id,
      sequence,
    })),
  }
}

export async function forkArchive(id: string, throughId: string, database = db) {
  return database.transaction(
    'rw',
    database.archives,
    database.messages,
    database.settings,
    async () => {
      const archive = await database.archives.get(id)
      if (!archive) throw new Error('存档不存在。')
      const all = await archiveMessages(id, database)
      const end = all.findIndex((message) => message.id === throughId)
      if (end < 0) throw new Error('消息不存在。')
      const copy = copyArchiveData(archive, all.slice(0, end + 1), `${archive.name} · 分支`)
      await database.archives.add(copy.archive)
      await database.messages.bulkAdd(copy.messages)
      await database.settings.update('app', { activeArchiveId: copy.archive.id })
      return copy.archive
    },
  )
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
    const previous = await db.messages.get(message.id)
    const last = await db.messages
      .where('[archiveId+sequence]')
      .between([message.archiveId, Dexie.minKey], [message.archiveId, Dexie.maxKey])
      .last()
    message.sequence = previous?.sequence ?? (last?.sequence ?? -1) + 1
    await db.messages.put(message)
    const updated = revise(archive)
    if (message.usage) updated.lastUsage = message.usage
    await db.archives.put(updated)
  })
  return message
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
      correction: undefined,
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

export function normalizeImport(input: unknown, restore = false): SaveFile {
  const raw = record(input)
  if (raw.version !== 1 && raw.version !== 2)
    throw new Error('仅支持版本 1 和版本 2 的盐焗 JSON 存档。')
  if (raw.version === 2)
    parseSave(saveFileSchema, {
      ...raw,
      exportedAt: raw.exportedAt ?? new Date().toISOString(),
      archives: raw.archives ?? [],
      messages: raw.messages ?? [],
      channels: raw.channels ?? [],
      masks: raw.masks ?? [],
      settings: { ...defaults, ...record(raw.settings ?? {}) },
    })
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
      maxOutputTokens: numeric(c.maxOutputTokens ?? c.maxTokens, 4096),
      contextWindow: numeric(c.contextWindow, 32768),
      requestTimeoutMs: numeric(c.requestTimeoutMs, 300000),
      createdAt: numeric(c.createdAt, Date.now()),
      calibration:
        raw.version === 2 ? parseSave(calibrationSchema.optional(), c.calibration) : undefined,
      capability: restore ? parseSave(capabilitySchema.optional(), c.capability) : undefined,
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
      lastUsage: parseSave(usageSchema.optional(), a.lastUsage),
      compactionError: str(a.compactionError) || undefined,
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
      messages.push(
        parseSave(storedMessageSchema, {
          ...m,
          content: str(m.content),
          correction:
            m.role === 'assistant' && typeof m.correction === 'string' ? m.correction : undefined,
          createdAt: numeric(m.createdAt, Date.now()),
          sequence: numeric(m.sequence, messages.length),
          status: ['complete', 'partial', 'failed', 'cancelled'].includes(str(m.status))
            ? m.status
            : 'complete',
        }),
      )
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
  return parseSave(saveFileSchema, {
    version: 2,
    exportedAt: new Date().toISOString(),
    channels,
    masks,
    archives,
    messages,
    settings,
  })
}

export async function importSave(
  input: unknown,
  database = db,
  restore = false,
  mode: 'replace' | 'merge' = 'replace',
) {
  const data = normalizeImport(input, restore)
  await withImportOperation(
    () =>
      database.transaction(
        'rw',
        [
          database.archives,
          database.messages,
          database.channels,
          database.personas,
          database.settings,
        ],
        async () => {
          if (mode === 'merge') {
            const remap = (incoming: { id: string }[], existing: string[]) => {
              const taken = new Set(existing)
              return new Map(
                incoming.map((item) => [
                  item.id,
                  taken.has(item.id) ? crypto.randomUUID() : item.id,
                ]),
              )
            }
            const archiveIds = remap(
              data.archives,
              await database.archives.toCollection().primaryKeys(),
            )
            const messageIds = remap(
              data.messages,
              await database.messages.toCollection().primaryKeys(),
            )
            const channelIds = remap(
              data.channels,
              await database.channels.toCollection().primaryKeys(),
            )
            const personaIds = remap(
              data.masks,
              await database.personas.toCollection().primaryKeys(),
            )
            const usage = (value: Archive['lastUsage']) =>
              value && { ...value, channelId: channelIds.get(value.channelId) ?? value.channelId }
            data.archives = data.archives.map((archive) => ({
              ...archive,
              id: archiveIds.get(archive.id)!,
              name:
                archiveIds.get(archive.id) !== archive.id ? `${archive.name} · 导入` : archive.name,
              lastUsage: usage(archive.lastUsage),
              summary: archive.summary && {
                ...archive.summary,
                coveredThroughId: messageIds.get(archive.summary.coveredThroughId)!,
              },
            }))
            data.messages = data.messages.map((message) => ({
              ...message,
              id: messageIds.get(message.id)!,
              archiveId: archiveIds.get(message.archiveId)!,
              usage: usage(message.usage),
            }))
            data.channels = data.channels.map((channel) => ({
              ...channel,
              id: channelIds.get(channel.id)!,
            }))
            data.masks = data.masks.map((persona) => ({
              ...persona,
              id: personaIds.get(persona.id)!,
            }))
            const existingSettings = (await database.settings.get('app')) ?? defaults
            data.settings = {
              ...existingSettings,
              activeArchiveId:
                archiveIds.get(data.settings.activeArchiveId) ??
                data.archives[0]?.id ??
                existingSettings.activeArchiveId,
            }
          } else {
            await Promise.all([
              database.archives.clear(),
              database.messages.clear(),
              database.channels.clear(),
              database.personas.clear(),
            ])
          }
          await database.archives.bulkPut(data.archives)
          await database.messages.bulkPut(data.messages)
          await database.channels.bulkPut(data.channels)
          await database.personas.bulkPut(data.masks)
          await database.settings.put(data.settings)
          if (!(await database.personas.count())) {
            const persona = newPersona()
            await database.personas.add(persona)
            await database.settings.update('app', { activePersonaId: persona.id })
            data.masks.push(persona)
            data.settings.activePersonaId = persona.id
          }
          if (!(await database.archives.count())) {
            const created = createArchiveData()
            await database.archives.add(created.archive)
            await database.messages.add(created.opening)
            await database.settings.update('app', { activeArchiveId: created.archive.id })
            data.archives.push(created.archive)
            data.messages.push(created.opening)
            data.settings.activeArchiveId = created.archive.id
          }
        },
      ),
    database,
  )
  return data
}
export async function exportArchive(id: string, database = db): Promise<SaveFile> {
  return database.transaction(
    'r',
    [database.archives, database.messages, database.channels, database.personas, database.settings],
    async () => {
      const archive = await database.archives.get(id)
      if (!archive) throw new Error('存档不存在。')
      return {
        version: 2,
        exportedAt: new Date().toISOString(),
        archives: [archive],
        messages: await archiveMessages(id, database),
        channels: await database.channels.toArray(),
        masks: await database.personas.toArray(),
        settings: { ...((await database.settings.get('app')) ?? defaults), activeArchiveId: id },
      }
    },
  )
}
export async function exportSave(database = db): Promise<SaveFile> {
  return readSaveSnapshot(database)
}
async function readSaveSnapshot(database: YanJuDatabase, messageIds?: string[]): Promise<SaveFile> {
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
      messages:
        messageIds === undefined
          ? await database.messages.toArray()
          : (await database.messages.bulkGet(messageIds)).filter((m): m is StoredMessage => !!m),
      channels: await database.channels.toArray(),
      masks: await database.personas.toArray(),
      settings: (await database.settings.get('app')) ?? defaults,
    }),
  )
}

async function readPersistenceSnapshot(
  database: YanJuDatabase,
  ids?: string[],
): Promise<PersistenceSnapshot> {
  return database.transaction(
    'r',
    [
      database.archives,
      database.messages,
      database.channels,
      database.personas,
      database.settings,
      database.persistenceChanges,
    ],
    async () => {
      const journal = await database.persistenceChanges.toArray()
      const messageIds =
        ids === undefined || journal.some((entry) => entry.id === 'all')
          ? undefined
          : [
              ...new Set([
                ...ids,
                ...journal
                  .filter((entry) => entry.id.startsWith('message:'))
                  .map((entry) => entry.id.slice('message:'.length)),
              ]),
            ]
      const data = await readSaveSnapshot(database, messageIds)
      return {
        data,
        messageIds,
        committed: () =>
          database.transaction('rw', database.persistenceChanges, async () => {
            const current = await database.persistenceChanges.bulkGet(
              journal.map((entry) => entry.id),
            )
            const acknowledged = journal.filter(
              (entry, index) => current[index]?.token === entry.token,
            )
            await database.persistenceChanges.bulkDelete(acknowledged.map((entry) => entry.id))
          }),
      }
    },
  )
}

const initializing = new WeakMap<YanJuDatabase, Promise<void>>()
export function initializeStorage(database = db) {
  const pending = initializing.get(database)
  if (pending) return pending
  const initialization = (async () => {
    await database.open()
    if (!(await database.settings.get('app')) && !(await database.archives.count())) {
      try {
        const saved = await database.persistence.read()
        if (saved) await importSave(saved, database, true)
      } catch (error) {
        database.persistence.preserveUnreadableSave(error)
      }
    }
    if (!(await database.settings.get('app'))) {
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
        await importSave(data, database)
      } else await database.settings.put({ ...defaults, migrated: true })
    }
    if (!(await database.personas.count())) {
      const persona = newPersona()
      await database.personas.add(persona)
      await database.settings.update('app', { activePersonaId: persona.id })
    }
    if (!(await database.archives.count())) await createArchive(undefined, database)
    const active = await activeArchiveOperations(database)
    await database.messages
      .filter((m) => m.status === 'partial' && !active.has(m.archiveId))
      .modify({ status: 'cancelled', error: '上次生成已中断，已保留收到的内容，可重试。' })
    await database.persistence.start()
  })().catch((error) => {
    initializing.delete(database)
    throw error
  })
  initializing.set(database, initialization)
  return initialization
}
