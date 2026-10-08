import Dexie, { type Table } from 'dexie'
import opening from '@/content/opening.txt?raw'
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
import { OpfsPersistence } from './opfs'
import { rebuildStory, type StoryState, type StoryEvent } from './story'
import type { TaskRun, RequestRecord } from './types'
import { taskSchemas, taskInputSchema, validateTask, type TaskKind } from './tasks'
import { effectsSchema } from './domain-schema'
import { channelFingerprint, withCapability } from './channels'

export class YanJuDatabase extends Dexie {
  archives!: Table<Archive, string>
  messages!: Table<StoredMessage, string>
  channels!: Table<Channel, string>
  personas!: Table<Persona, string>
  settings!: Table<Settings, string>
  storyStates!: Table<StoryState, string>
  storyEvents!: Table<StoryEvent, string>
  tasks!: Table<TaskRun, string>
  requests!: Table<RequestRecord, string>
  readonly persistence: OpfsPersistence
  constructor(name = 'yanju-v3') {
    super(name)
    this.persistence = new OpfsPersistence(name, () => exportSave(this))
    this.version(1).stores({
      archives: 'id,updatedAt',
      messages: 'id,archiveId,[archiveId+sequence]',
      channels: 'id,createdAt',
      personas: 'id,createdAt',
      settings: 'id',
      storyStates: 'archiveId',
      storyEvents: 'id,archiveId,[archiveId+sequence]',
      tasks: 'id,archiveId,createdAt',
    })
    this.version(2).stores({ requests: 'id,archiveId,kind,createdAt,[archiveId+createdAt]' })
    this.use({
      stack: 'dbcore',
      name: 'opfs-persistence',
      create: (core) => ({
        ...core,
        transaction: (stores, mode, options) => {
          const transaction = core.transaction(stores, mode, options)
          if (mode === 'readwrite')
            (transaction as IDBTransaction).addEventListener('complete', () =>
              this.persistence.markDirty(),
            )
          return transaction
        },
      }),
    })
  }
}
export const db = new YanJuDatabase()
export const archiveMessages = (id: string, database = db) =>
  database.messages.where('archiveId').equals(id).sortBy('sequence')

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

export async function saveRequestRecord(request: RequestRecord) {
  await db.transaction('rw', [db.archives, db.requests], async () => {
    const available = request.archiveId === null || (await db.archives.get(request.archiveId))
    await db.requests.put({ ...request, archiveId: available ? request.archiveId : null })
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
    kind: 'opening',
    status: 'complete',
    createdAt: now,
    sequence: 0,
  }
  return { archive, opening: msg }
}
export async function createArchive(name?: string, database = db) {
  const data = createArchiveData(name)
  const settings = await database.settings.get('app')
  const persona = settings?.activePersonaId
    ? await database.personas.get(settings.activePersonaId)
    : undefined
  data.archive.userName = persona?.name ?? '沈辞玉'
  await database.transaction(
    'rw',
    database.archives,
    database.messages,
    database.settings,
    database.storyStates,
    database.storyEvents,
    async () => {
      await database.archives.add(data.archive)
      await database.messages.add(data.opening)
      await refreshStory(database, data.archive)
      await database.settings.update('app', { activeArchiveId: data.archive.id })
    },
  )
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
  await db.transaction('rw', db.archives, db.messages, db.storyStates, db.storyEvents, async () => {
    const archive = await db.archives.get(message.archiveId)
    if (!archive || (expectedRevision !== undefined && archive.revision !== expectedRevision))
      throw new Error('存档已在其他窗口修改，请重新载入后重试。')
    const existing = await db.messages.get(message.id)
    if (existing?.status === 'complete') {
      if (JSON.stringify(existing) === JSON.stringify(message)) return
      throw new Error('消息 ID 已提交，不能重复覆盖。')
    }
    if (
      await db.messages
        .where('[archiveId+sequence]')
        .equals([message.archiveId, message.sequence])
        .filter((m) => m.id !== message.id)
        .count()
    )
      throw new Error('消息序号已被其他窗口占用，请重新载入后重试。')
    if (message.reply?.kind === 'narrative')
      rebuildStory(archive, [...(await archiveMessages(archive.id)), message])
    await db.messages.put(message)
    const updated = revise(archive)
    if (message.usage) updated.lastUsage = message.usage
    await db.archives.put(updated)
    await refreshStory(db, updated)
  })
}
export async function editMessage(id: string, content: string) {
  await db.transaction('rw', db.archives, db.messages, db.storyStates, db.storyEvents, async () => {
    const message = await db.messages.get(id)
    if (!message) throw new Error('消息不存在')
    const archive = await db.archives.get(message.archiveId)
    if (!archive) throw new Error('存档不存在')
    let next: StoredMessage = {
      ...message,
      content,
      rawContent: undefined,
      requestContext: undefined,
      stale: false,
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
    } else if (message.interaction) {
      const text = z.string().refine((value) => !!value.trim(), '内容不能为空')
      const interaction = z
        .discriminatedUnion('kind', [
          z.strictObject({
            kind: z.literal('phone'),
            contactRef: text,
            userText: text,
            speaker: text,
            time: text,
            text,
          }),
          z.strictObject({
            kind: z.literal('forum'),
            postId: text,
            replyTo: text,
            userText: text,
            author: text,
            time: text,
            content: text,
          }),
        ])
        .parse(JSON.parse(content))
      const user = message.userName ?? archive.userName ?? '你'
      next = {
        ...next,
        interaction,
        content:
          interaction.kind === 'phone'
            ? `${user}：${interaction.userText}\n${interaction.speaker}：${interaction.text}`
            : `${user}：${interaction.userText}\n${interaction.author}：${interaction.content}`,
      }
    } else if (message.effects) {
      const material = z
        .strictObject({ content: z.string().min(1), effects: effectsSchema })
        .parse(JSON.parse(content))
      next = { ...next, ...material }
    } else if (message.role === 'assistant') next = { ...next, kind: message.kind }
    rebuildStory(archive, [
      ...(await archiveMessages(archive.id)).filter((m) => m.sequence < next.sequence),
      next,
    ])
    await db.messages.put(next)
    const all = await archiveMessages(archive.id)
    const coveredIndex = all.findIndex((m) => m.id === archive.summary?.coveredThroughId)
    const updated = revise(
      archive,
      !!archive.summary && all.findIndex((m) => m.id === id) <= coveredIndex,
    )
    const tail = all.filter((m) => m.sequence > message.sequence)
    await db.messages.bulkPut(tail.map((m) => ({ ...m, stale: true })))
    await db.archives.put(updated)
    await refreshStory(db, updated)
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

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)
const record = (v: unknown): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(v)
const list = (v: unknown) => z.array(z.unknown()).parse(v ?? [])

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
      baseUrl: z.string().parse(c.baseUrl),
      apiKey: z.string().parse(c.apiKey),
      model: z.string().parse(c.model),
      apiMode: z.enum(['auto', 'chat-completions', 'responses']).parse(c.apiMode),
      temperature: z.number().min(0).max(2).nullable().parse(c.temperature),
      maxOutputTokens: z.number().int().min(128).parse(c.maxOutputTokens),
      contextWindow: z.number().int().min(1024).parse(c.contextWindow),
      createdAt: z.number().parse(c.createdAt),
      calibration: c.calibration as Channel['calibration'],
      capability: restore ? (c.capability as Channel['capability']) : undefined,
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
      createdAt: z.number().parse(p.createdAt),
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
      createdAt: z.number().parse(a.createdAt),
      updatedAt: z.number().parse(a.updatedAt),
      revision: z.number().int().nonnegative().parse(a.revision),
      draft: str(a.draft),
      userName: str(a.userName, '沈辞玉'),
      description: str(a.description) || undefined,
      keywords: a.keywords === undefined ? undefined : z.array(z.string()).parse(a.keywords),
      summary,
      lastUsage: a.lastUsage as Archive['lastUsage'],
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
      createdAt: z.number().parse(m.createdAt),
      sequence: z.number().int().nonnegative().parse(m.sequence),
      status: z.enum(['complete', 'partial', 'failed', 'cancelled']).parse(m.status),
      stale: m.stale === undefined ? undefined : z.boolean().parse(m.stale),
      requestContext:
        m.requestContext === undefined ? undefined : z.string().parse(m.requestContext),
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
      createdAt: z.number().parse(t.createdAt),
      revision: z.number().int().parse(t.revision),
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
    z.number().int().positive().parse(request.maxOutputTokens)
    z.number().min(0).max(2).nullable().parse(request.temperature)
    z.boolean().parse(request.streaming)
    z.object({
      id: z.string(),
      name: z.string(),
      baseUrl: z.string(),
      model: z.string(),
      protocol: z.enum(['responses', 'chat-completions']),
    }).parse(r.channel)
    return {
      ...r,
      id: z.string().min(1).parse(r.id),
      createdAt: z.number().parse(r.createdAt),
      estimatedInput: z.number().nonnegative().parse(r.estimatedInput),
      attempt: z.number().int().min(0).max(1).parse(r.attempt),
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

export async function refreshStory(database: YanJuDatabase, archive: Archive) {
  const projection = rebuildStory(archive, await archiveMessages(archive.id, database))
  await database.storyStates.put(projection.story)
  await database.storyEvents.where('archiveId').equals(archive.id).delete()
  await database.storyEvents.bulkPut(projection.events)
}

export async function importSave(input: unknown, database = db, restore = false) {
  const data = normalizeImport(input, restore)
  await database.transaction(
    'rw',
    [
      database.archives,
      database.messages,
      database.channels,
      database.personas,
      database.settings,
      database.storyStates,
      database.storyEvents,
      database.tasks,
      database.requests,
    ],
    async () => {
      await Promise.all([
        database.archives.clear(),
        database.messages.clear(),
        database.channels.clear(),
        database.personas.clear(),
        database.storyStates.clear(),
        database.storyEvents.clear(),
        database.tasks.clear(),
        database.requests.clear(),
      ])
      await database.archives.bulkPut(data.archives)
      await database.messages.bulkPut(data.messages)
      await database.storyStates.bulkPut(data.storyStates)
      await database.storyEvents.bulkPut(data.storyEvents)
      await database.tasks.bulkPut(data.tasks)
      await database.requests.bulkPut(data.requests)
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
    [
      database.archives,
      database.messages,
      database.channels,
      database.personas,
      database.settings,
      database.storyStates,
      database.storyEvents,
      database.tasks,
      database.requests,
    ],
    async () => ({
      version: 3,
      exportedAt: new Date().toISOString(),
      archives: await database.archives.toArray(),
      messages: await database.messages.toArray(),
      channels: await database.channels.toArray(),
      masks: await database.personas.toArray(),
      settings: (await database.settings.get('app')) ?? defaults,
      storyStates: await database.storyStates.toArray(),
      storyEvents: await database.storyEvents.toArray(),
      tasks: await database.tasks.toArray(),
      requests: await database.requests.toArray(),
    }),
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
    if (!(await database.settings.get('app')))
      await database.settings.put({ ...defaults, migrated: true })
    if (!(await database.personas.count())) {
      const persona = newPersona()
      await database.personas.add(persona)
      await database.settings.update('app', { activePersonaId: persona.id })
    }
    if (!(await database.archives.count())) await createArchive(undefined, database)
    await database.messages
      .filter((m) => m.status === 'partial')
      .modify({ status: 'cancelled', error: '上次生成已中断，已保留收到的内容，可重试。' })
    await database.tasks
      .filter((t) => t.status === 'partial')
      .modify({ status: 'cancelled', error: '上次任务已中断，可重试。' })
    await database.requests
      .filter((r) => r.status === 'partial')
      .modify({ status: 'cancelled', error: '上次请求已中断。' })
    await database.persistence.start()
  })().catch((error) => {
    initializing.delete(database)
    throw error
  })
  initializing.set(database, initialization)
  return initialization
}
