import type { SaveFile } from './types'

export const OPFS_SAVE_FILE = 'save.json'

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

  constructor(
    private name: string,
    private snapshot: () => Promise<SaveFile>,
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
    try {
      const directory = await this.directory()
      const handle = await directory.getFileHandle(OPFS_SAVE_FILE)
      const file = await handle.getFile()
      return JSON.parse(await file.text()) as unknown
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return undefined
      throw error
    }
  }

  async start() {
    this.enabled = true
    if (!this.available()) return
    void this.requestPersistence()
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

  markDirty() {
    if (!this.enabled) return
    this.dirty++
    if (!this.available()) return
    if (this.state.phase !== 'error') this.update({ phase: 'saving' })
    // Coalesce draft edits and streaming checkpoints; terminal replies flush immediately.
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.flush()
      }, 100)
  }

  async flush(): Promise<StorageStatus> {
    if (!this.enabled || !this.available()) return this.state
    this.dirty++
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
        const write = async () => {
          // Read inside the cross-tab lock so an older snapshot cannot overwrite a newer one.
          const data = await this.snapshot()
          const directory = await this.directory()
          const handle = await directory.getFileHandle(OPFS_SAVE_FILE, { create: true })
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
        if (navigator.locks) await navigator.locks.request(`yanju-opfs:${this.name}`, write)
        else await write()
        this.saved = revision
      }
      this.update({ phase: 'saved', error: undefined })
    } catch (error) {
      // Keep the working database and the previous OPFS save available for export/retry.
      this.reportError(error)
    }
  }
}
