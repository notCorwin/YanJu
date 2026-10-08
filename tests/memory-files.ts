import type { FileStorage } from '../src/lib/file-storage'

/** Unit tests simulate file storage; browser tests exercise actual OPFS. */
export class MemoryFiles implements FileStorage {
  data = new Map<string, Blob>()
  enabled = true
  available() {
    return this.enabled
  }
  async write(path: string, data: Blob | string) {
    this.data.set(path, typeof data === 'string' ? new Blob([data]) : data)
  }
  async read(path: string) {
    const blob = this.data.get(path)
    if (!blob) throw new DOMException('File missing', 'NotFoundError')
    return Object.assign(blob, {
      text: () =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.onerror = () => reject(reader.error)
          reader.readAsText(blob)
        }),
      arrayBuffer: () =>
        new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as ArrayBuffer)
          reader.onerror = () => reject(reader.error)
          reader.readAsArrayBuffer(blob)
        }),
    })
  }
  async remove(path: string) {
    this.data.delete(path)
  }
  async list(directory: string) {
    const prefix = `${directory}/`
    return [...this.data.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
      .filter((name) => !name.includes('/'))
  }
}
