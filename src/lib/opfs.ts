import type { SaveFile } from './types'
import { OpfsSnapshotWriter, readOpfsSnapshot } from './opfs-snapshot'

export const OPFS_SAVE_FILE = 'save.json'

export interface PersistenceSnapshot {
  data: SaveFile
  messageIds?: string[]
  committed: () => Promise<void>
}

export interface StorageStatus {
  phase: 'opening' | 'saving' | 'saved' | 'unavailable' | 'error'
  persistent: boolean
  error?: string
}

/** IndexedDB is the working database; OPFS holds an atomic, recoverable full save. */
export class OpfsPersistence {
  private state: StorageStatus = { phase: 'opening', persistent: false }
  private listeners = new Set<() => void>()
  private enabled = false
  private dirty = 0
  private saved = 0
  private preservePrevious = false
  private running?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private messages = new Set<string>()
  private fullSnapshot = true
  private writer = new OpfsSnapshotWriter()

  constructor(
    private name: string,
    private snapshot: (messageIds?: string[]) => Promise<SaveFile | PersistenceSnapshot>,
    private incremental = false,
  ) {}

  getStatus = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private update(patch: Partial<StorageStatus>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }

  reportError(error: unknown) {
    this.update({
      phase: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
  }

  preserveUnreadableSave(error: unknown) {
    this.preservePrevious = true
    this.reportError(error)
  }

  private available() {
    if (typeof navigator.storage?.getDirectory === 'function') return true
    this.update({ phase: 'unavailable', error: undefined })
    return false
  }

  private async directory() {
    const root = await navigator.storage.getDirectory()
    return root.getDirectoryHandle(this.name, { create: true })
  }

  async read(): Promise<unknown | undefined> {
    if (!this.available()) return undefined
    const read = async () => readOpfsSnapshot(await this.directory())
    // A reader must keep the old manifest's files alive while a writer commits and cleans up.
    return navigator.locks ? navigator.locks.request(`yanju-opfs:${this.name}`, read) : read()
  }

  async start() {
    this.enabled = true
    if (!this.available()) return
    void this.requestPersistence()
    this.markDirty()
    await this.flush()
  }

  private async requestPersistence() {
    // A denied persistence grant does not prevent OPFS reads or writes.
    try {
      const persistent =
        (await navigator.storage.persisted?.()) || (await navigator.storage.persist?.()) || false
      this.update({ persistent })
    } catch {
      this.update({ persistent: false })
    }
  }

  stop() {
    this.enabled = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  markDirty(messageIds?: string[]) {
    if (!this.enabled) return
    this.dirty++
    if (messageIds === undefined) this.fullSnapshot = true
    else messageIds.forEach((id) => this.messages.add(id))
    if (!this.available()) return
    if (this.state.phase !== 'error') this.update({ phase: 'saving' })
    // Coalesce draft edits and streaming checkpoints; terminal replies flush immediately.
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, 400)
  }

  async flush(): Promise<StorageStatus> {
    if (!this.enabled || !this.available()) return this.state
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    while (this.saved < this.dirty) {
      if (!this.running) {
        this.running = this.sync().finally(() => {
          this.running = undefined
        })
      }
      await this.running
      if (this.state.phase === 'error') break
    }
    return this.state
  }

  private async sync() {
    this.update({ phase: 'saving' })
    try {
      while (this.saved < this.dirty) {
        const revision = this.dirty
        const messageIds = this.fullSnapshot ? undefined : [...this.messages]
        this.fullSnapshot = false
        this.messages.clear()
        const write = async () => {
          // Read inside the cross-tab lock so an older snapshot cannot overwrite a newer one.
          const snapshot = await this.snapshot(this.incremental ? messageIds : undefined)
          const data = 'data' in snapshot ? snapshot.data : snapshot
          const changed = 'data' in snapshot ? snapshot.messageIds : messageIds
          const directory = await this.directory()
          const handle = await directory.getFileHandle(OPFS_SAVE_FILE, { create: true })
          const preserveFiles = this.preservePrevious
          if (this.preservePrevious) {
            const previous = await (await handle.getFile()).text()
            const backup = await directory.getFileHandle('save-recovery.json', { create: true })
            const stream = await backup.createWritable()
            try {
              await stream.write(previous)
              await stream.close()
              this.preservePrevious = false
            } catch (error) {
              await stream.abort().catch(() => undefined)
              throw error
            }
          }
          if (this.incremental) {
            await this.writer.write(directory, data, changed, preserveFiles)
            if ('data' in snapshot) await snapshot.committed()
            return
          }
          const stream = await handle.createWritable()
          try {
            await stream.write(JSON.stringify(data))
            // createWritable replaces the previous file only after close succeeds.
            await stream.close()
          } catch (error) {
            await stream.abort().catch(() => undefined)
            throw error
          }
        }
        try {
          if (navigator.locks) await navigator.locks.request(`yanju-opfs:${this.name}`, write)
          else await write()
        } catch (error) {
          if (messageIds === undefined) this.fullSnapshot = true
          else messageIds.forEach((id) => this.messages.add(id))
          throw error
        }
        this.saved = revision
      }
      this.update({ phase: 'saved', error: undefined })
    } catch (error) {
      // Keep the working database and the previous OPFS save available for export/retry.
      this.reportError(error)
    }
  }
}
