/** Files are private to this app; directory names are relative to its OPFS root. */
export interface FileStorage {
  available(): boolean
  write(path: string, data: Blob | string): Promise<void>
  read(path: string): Promise<Blob>
  remove(path: string): Promise<void>
  list(directory: string): Promise<string[]>
}

export const storageLockName = 'yanju-v2:storage'
let unavailableLocks: LockManager | undefined

export function supportsFileStorage() {
  return (
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof navigator.locks?.request === 'function' &&
    navigator.locks !== unavailableLocks
  )
}

export async function withStorageLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = navigator.locks
  if (typeof locks?.request === 'function' && locks !== unavailableLocks) {
    let acquired = false
    try {
      return await locks.request(storageLockName, () => {
        acquired = true
        return operation()
      })
    } catch (error) {
      if (acquired) throw error
      unavailableLocks = locks
    }
  }
  return operation()
}

export class OpfsFileStorage implements FileStorage {
  available = supportsFileStorage

  private async directory(path: string, create = false) {
    let directory = await navigator.storage.getDirectory()
    for (const name of path.split('/').filter(Boolean))
      directory = await directory.getDirectoryHandle(name, { create })
    return directory
  }

  private async parent(path: string, create = false) {
    const parts = path.split('/')
    const name = parts.pop()!
    return { directory: await this.directory(parts.join('/'), create), name }
  }

  async write(path: string, data: Blob | string) {
    const { directory, name } = await this.parent(path, true)
    const file = await directory.getFileHandle(name, { create: true })
    const writer = await file.createWritable()
    try {
      await writer.write(data)
      await writer.close()
    } catch (error) {
      await writer.abort().catch(() => undefined)
      throw error
    }
  }

  async read(path: string) {
    const { directory, name } = await this.parent(path)
    const file = await (await directory.getFileHandle(name)).getFile()
    // Materialize the bytes while holding the lock so later replacement/deletion
    // cannot invalidate a File snapshot used by a Blob URL or JSON export.
    return new Blob([await file.arrayBuffer()], { type: file.type })
  }

  async remove(path: string) {
    const { directory, name } = await this.parent(path)
    await directory.removeEntry(name)
  }

  async list(path: string) {
    try {
      const directory = await this.directory(path)
      const names: string[] = []
      for await (const name of directory.keys()) names.push(name)
      return names
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return []
      throw error
    }
  }
}

export const files = new OpfsFileStorage()

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败，请重试。'))
    reader.readAsDataURL(blob)
  })
}

export function dataUrlToImage(value: string): Blob | undefined {
  const match = /^data:(image\/[\w.+-]+)((?:;[^,]*)?),(.*)$/is.exec(value)
  if (!match) return undefined
  try {
    const parameters = match[2].split(';').filter((part) => part && part !== 'base64')
    const mimeType = [match[1], ...parameters].join(';')
    const bytes = match[2].split(';').includes('base64')
      ? Uint8Array.from(atob(decodeURIComponent(match[3])), (char) => char.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(match[3]))
    return new Blob([bytes], { type: mimeType })
  } catch {
    return undefined
  }
}
