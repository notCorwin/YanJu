import {
  defaults,
  type Archive,
  type Channel,
  type Persona,
  type Settings,
  type StoredMessage,
} from './types'
import Dexie, { type Table } from 'dexie'
import { files, withStorageLock, type FileStorage } from './file-storage'

type Rows = {
  archives: Archive
  messages: StoredMessage
  channels: Channel
  personas: Persona
  settings: Settings
}
type Name = keyof Rows
type MetadataName = Exclude<Name, 'messages'>
type Catalog = {
  version: 1
  records: { [K in MetadataName]: Rows[K][] }
  messageFiles: Record<string, string>
}
const emptyCatalog = (): Catalog => ({
  version: 1,
  records: { archives: [], channels: [], personas: [], settings: [] },
  messageFiles: {},
})
const clone = <T>(value: T): T => structuredClone(value)

class ConfigurationDatabase extends Dexie {
  channels!: Table<Channel, string>
  personas!: Table<Persona, string>
  settings!: Table<Settings, string>
  constructor(name: string) {
    super(name)
    this.version(1).stores({
      channels: 'id,createdAt',
      personas: 'id,createdAt',
      settings: 'id',
    })
  }
}

type Runner = {
  run<T>(write: boolean, operation: (session: StorageSession) => Promise<T>): Promise<T>
}

class Query<K extends Name> {
  constructor(
    private table: StorageTable<K>,
    private predicate: (row: Rows[K]) => boolean = () => true,
    private order?: keyof Rows[K],
    private descending = false,
  ) {}
  reverse() {
    return new Query(this.table, this.predicate, this.order, !this.descending)
  }
  async toArray() {
    const values = (await this.table.toArray()).filter(this.predicate)
    if (this.order) {
      const field = this.order
      values.sort((a, b) => Number(a[field]) - Number(b[field]))
    }
    return this.descending ? values.reverse() : values
  }
  sortBy(field: keyof Rows[K]) {
    return new Query(this.table, this.predicate, field).toArray()
  }
  async first() {
    return (await this.toArray())[0]
  }
  delete() {
    return this.table.change((rows) => rows.filter((row) => !this.predicate(row)))
  }
  modify(changes: Partial<Rows[K]>) {
    return this.table.change((rows) =>
      rows.map((row) => (this.predicate(row) ? { ...row, ...changes } : row)),
    )
  }
}

export class StorageTable<K extends Name> {
  constructor(
    private runner: Runner,
    readonly name: K,
  ) {}
  toArray() {
    return this.runner.run(false, async (session) => clone(await session.values(this.name)))
  }
  async get(id: string) {
    return (await this.toArray()).find((row) => row.id === id)
  }
  async count() {
    return (await this.toArray()).length
  }
  change(transform: (rows: Rows[K][]) => Rows[K][]) {
    return this.runner.run(true, async (session) => {
      const values = clone(await session.values(this.name))
      const next = transform(clone(values))
      if (JSON.stringify(next) !== JSON.stringify(values)) session.assign(this.name, next)
    })
  }
  async add(value: Rows[K]) {
    await this.change((rows) => {
      if (rows.some((row) => row.id === value.id)) throw new Error('存在重复 ID。')
      return [...rows, clone(value)]
    })
    return value.id
  }
  async put(value: Rows[K]) {
    await this.bulkPut([value])
    return value.id
  }
  bulkPut(values: Rows[K][]) {
    return this.change((rows) => {
      const result = new Map(rows.map((row) => [row.id, row]))
      for (const row of values) result.set(row.id, clone(row))
      return [...result.values()]
    })
  }
  update(id: string, changes: Partial<Rows[K]>) {
    return this.change((rows) => rows.map((row) => (row.id === id ? { ...row, ...changes } : row)))
  }
  delete(id: string) {
    return this.bulkDelete([id])
  }
  bulkDelete(ids: string[]) {
    const remove = new Set(ids)
    return this.change((rows) => rows.filter((row) => !remove.has(row.id)))
  }
  clear() {
    return this.runner.run(true, async (session) => session.assign(this.name, []))
  }
  filter(predicate: (row: Rows[K]) => boolean) {
    return new Query(this, predicate)
  }
  where(field: keyof Rows[K]) {
    return { equals: (value: unknown) => this.filter((row) => row[field] === value) }
  }
  orderBy(field: keyof Rows[K]) {
    return new Query(this, undefined, field)
  }
  toCollection() {
    return new Query(this)
  }
}

export class StorageSession implements Runner {
  readonly archives = new StorageTable(this, 'archives')
  readonly messages = new StorageTable(this, 'messages')
  readonly channels = new StorageTable(this, 'channels')
  readonly personas = new StorageTable(this, 'personas')
  readonly settings = new StorageTable(this, 'settings')
  private loadedMessages?: StoredMessage[]
  private initialMessages = new Map<string, string>()
  private dirty = new Set<Name>()
  private created = new Set<string>()
  private original: Catalog

  constructor(
    readonly catalog: Catalog,
    readonly storage: FileStorage,
    readonly root: string,
    private persist: (catalog: Catalog, original: Catalog, dirty: Set<Name>) => Promise<void>,
  ) {
    this.original = clone(catalog)
  }
  run<T>(_write: boolean, operation: (session: StorageSession) => Promise<T>) {
    return operation(this)
  }
  async values<K extends Name>(name: K): Promise<Rows[K][]> {
    if (name !== 'messages') return this.catalog.records[name as MetadataName] as Rows[K][]
    if (!this.loadedMessages) {
      this.loadedMessages = []
      for (const archive of this.catalog.records.archives) {
        const file = Object.hasOwn(this.catalog.messageFiles, archive.id)
          ? this.catalog.messageFiles[archive.id]
          : undefined
        if (!file) {
          if (!this.original.records.archives.some((a) => a.id === archive.id)) continue
          throw new Error(`存档「${archive.name}」缺少消息文件，请导入完整存档恢复。`)
        }
        const content = await this.storage.read(`${this.root}/archives/${file}`)
        const messages: StoredMessage[] = JSON.parse(await content.text())
        if (!Array.isArray(messages) || messages.some((m) => m.archiveId !== archive.id))
          throw new Error(`存档「${archive.name}」的消息文件无法读取。`)
        this.initialMessages.set(archive.id, JSON.stringify(messages))
        this.loadedMessages.push(...messages)
      }
    }
    return this.loadedMessages as Rows[K][]
  }
  assign<K extends Name>(name: K, rows: Rows[K][]) {
    this.dirty.add(name)
    if (name === 'messages') this.loadedMessages = rows as StoredMessage[]
    else Object.assign(this.catalog.records, { [name]: rows })
  }
  trackFile(path: string) {
    this.created.add(path)
  }
  private reachable(catalog: Catalog) {
    return new Set([
      ...Object.values(catalog.messageFiles).map((file) => `${this.root}/archives/${file}`),
      ...catalog.records.settings.flatMap((s) =>
        s.bgImageRef ? [`${this.root}/backgrounds/${s.bgImageRef.id}`] : [],
      ),
      ...catalog.records.settings.flatMap((s) =>
        s.archiveCatalogId ? [`${this.root}/catalogs/${s.archiveCatalogId}.json`] : [],
      ),
    ])
  }
  async commit() {
    if (!this.dirty.size) return false
    if (
      this.dirty.has('messages') &&
      this.loadedMessages?.some(
        (message) =>
          !this.catalog.records.archives.some((archive) => archive.id === message.archiveId),
      )
    )
      throw new Error('消息缺少所属篇章，保存未提交。')
    if (this.dirty.has('messages') || this.dirty.has('archives')) {
      const next: Record<string, string> = Object.create(null)
      for (const archive of this.catalog.records.archives) {
        let file = Object.hasOwn(this.catalog.messageFiles, archive.id)
          ? this.catalog.messageFiles[archive.id]
          : undefined
        if (this.dirty.has('messages') || !file) {
          const messages = (this.loadedMessages ?? [])
            .filter((m) => m.archiveId === archive.id)
            .sort((a, b) => a.sequence - b.sequence)
          const content = JSON.stringify(messages)
          if (!file || content !== this.initialMessages.get(archive.id)) {
            file = `${crypto.randomUUID()}.json`
            const path = `${this.root}/archives/${file}`
            this.trackFile(path)
            await this.storage.write(path, content)
          }
        }
        next[archive.id] = file!
      }
      this.catalog.messageFiles = next
    }
    // Immutable files are complete before the catalog atomically switches their
    // references. A failed catalog write leaves every previous record intact.
    if (this.dirty.has('archives') || this.dirty.has('messages')) {
      if (!this.catalog.records.settings.some((s) => s.id === 'app'))
        this.catalog.records.settings.push({ ...defaults })
      const id = crypto.randomUUID()
      const path = `${this.root}/catalogs/${id}.json`
      this.trackFile(path)
      await this.storage.write(
        path,
        JSON.stringify({
          ...this.catalog,
          records: {
            archives: this.catalog.records.archives,
            settings: [],
            channels: [],
            personas: [],
          },
        }),
      )
      this.catalog.records.settings = this.catalog.records.settings.map((s) => ({
        ...s,
        archiveCatalogId: id,
      }))
    }
    await this.persist(this.catalog, this.original, this.dirty)
    this.created.clear()
    const retained = this.reachable(this.catalog)
    for (const path of this.reachable(this.original))
      if (!retained.has(path)) await this.storage.remove(path).catch(() => undefined)
    return true
  }
  async discard() {
    for (const path of this.created) await this.storage.remove(path).catch(() => undefined)
  }
  async cleanup() {
    const retained = this.reachable(this.catalog)
    for (const directory of ['archives', 'backgrounds', 'catalogs']) {
      const path = `${this.root}/${directory}`
      const names = await this.storage.list(path)
      for (const name of names)
        if (!retained.has(`${path}/${name}`))
          await this.storage.remove(`${path}/${name}`).catch(() => undefined)
    }
  }
}

export class YanJuDatabase implements Runner {
  readonly archives = new StorageTable(this, 'archives')
  readonly messages = new StorageTable(this, 'messages')
  readonly configuration: ConfigurationDatabase
  readonly channels: Table<Channel, string>
  readonly personas: Table<Persona, string>
  readonly settings: Table<Settings, string>
  private queue: Promise<unknown> = Promise.resolve()
  private listeners = new Set<() => void>()
  private channel?: BroadcastChannel
  private revision = 0
  constructor(
    readonly storage: FileStorage = files,
    readonly root = 'yanju-v2',
    name = 'yanju-v2-config',
  ) {
    this.configuration = new ConfigurationDatabase(name)
    this.channels = this.configuration.channels
    this.personas = this.configuration.personas
    this.settings = this.configuration.settings
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getRevision = () => this.revision
  private notify = () => {
    this.revision++
    for (const listener of this.listeners) listener()
  }
  async open() {
    await this.configuration.open()
    if (!this.storage.available())
      throw new Error('此浏览器无法打开 OPFS 本地文件存储。请使用支持 OPFS 和 Web Locks 的浏览器。')
    if (!this.channel && typeof window.BroadcastChannel === 'function') {
      this.channel = new BroadcastChannel(`${this.root}:changes`)
      this.channel.onmessage = this.notify
    }
    await this.read(async () => undefined)
  }
  close() {
    this.channel?.close()
    this.channel = undefined
    this.configuration.close()
  }
  private async persist(catalog: Catalog, original: Catalog, dirty: Set<Name>, replace: boolean) {
    const database = this.configuration
    await database.transaction(
      'rw',
      database.settings,
      database.channels,
      database.personas,
      async () => {
        const current = await database.settings.get('app')
        if (
          current?.archiveCatalogId !==
          original.records.settings.find((s) => s.id === 'app')?.archiveCatalogId
        )
          throw new Error('存档已在其他窗口变更，请重试。')
        for (const name of ['channels', 'personas'] as const) {
          if (!dirty.has(name)) continue
          const table = database[name] as Table<Channel | Persona, string>
          await table.clear()
          await table.bulkPut(catalog.records[name])
        }
        const next = catalog.records.settings.find((s) => s.id === 'app')
        if (replace && dirty.has('settings')) {
          await database.settings.clear()
          if (next) await database.settings.put(next)
        } else if (next) {
          const previous = original.records.settings.find((s) => s.id === 'app')
          const changes: Record<string, unknown> = {}
          for (const key of new Set([...Object.keys(previous ?? {}), ...Object.keys(next)])) {
            const field = key as keyof Settings
            if (JSON.stringify(previous?.[field]) !== JSON.stringify(next[field]))
              changes[key] = next[field]
          }
          if (current) await database.settings.update('app', changes)
          else await database.settings.put(next)
        }
      },
    )
  }
  run<T>(
    write: boolean,
    operation: (session: StorageSession) => Promise<T>,
    replace = false,
  ): Promise<T> {
    const pending = this.queue.then(() =>
      withStorageLock(async () => {
        if (!this.storage.available())
          throw new Error('OPFS 本地文件存储不可用，请使用支持 OPFS 和 Web Locks 的浏览器。')
        let catalog = emptyCatalog()
        const config = await this.configuration.transaction(
          'r',
          this.settings,
          this.channels,
          this.personas,
          async () => ({
            settings: await this.settings.toArray(),
            channels: await this.channels.toArray(),
            personas: await this.personas.toArray(),
          }),
        )
        const catalogId = config.settings.find((s) => s.id === 'app')?.archiveCatalogId
        try {
          if (catalogId) {
            const file = await this.storage.read(`${this.root}/catalogs/${catalogId}.json`)
            const parsed: Catalog = JSON.parse(await file.text())
            if (
              parsed.version !== 1 ||
              !parsed.messageFiles ||
              !Array.isArray(parsed.records?.archives)
            )
              throw new Error('本地存档目录无法读取，请导入完整 JSON 存档恢复。')
            catalog = parsed
          }
        } catch (error) {
          if (!replace)
            throw new Error('本地存档目录无法读取，请导入完整 JSON 存档恢复。', { cause: error })
        }
        Object.assign(catalog.records, config)
        const session = new StorageSession(
          catalog,
          this.storage,
          this.root,
          (next, original, dirty) => this.persist(next, original, dirty, replace),
        )
        try {
          const result = await operation(session)
          if (write && (await session.commit())) {
            this.notify()
            this.channel?.postMessage('changed')
          }
          return result
        } catch (error) {
          await session.discard()
          throw error
        }
      }),
    )
    this.queue = pending.catch(() => undefined)
    return pending
  }
  read<T>(operation: (session: StorageSession) => Promise<T>) {
    return this.run(false, operation)
  }
  mutate<T>(operation: (session: StorageSession) => Promise<T>) {
    return this.run(true, operation)
  }
  replace<T>(operation: (session: StorageSession) => Promise<T>) {
    return this.run(true, operation, true)
  }
  cleanup() {
    return this.read((session) => session.cleanup()).catch(() => undefined)
  }
}
