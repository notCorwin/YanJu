import { z } from 'zod'
import type { SaveFile, StoredMessage } from './types'

export const OPFS_FORMAT = 'yanju-opfs-3'
const reference = z.object({
  id: z.string(),
  archiveId: z.string(),
  file: z.string().regex(/^message-[\w-]+\.json$/),
})
const manifestSchema = z.object({
  format: z.literal(OPFS_FORMAT),
  data: z.record(z.string(), z.unknown()),
  messages: z.array(reference),
  backgroundFile: z
    .string()
    .regex(/^background-[\w-]+\.txt$/)
    .optional(),
})
type Manifest = z.infer<typeof manifestSchema>

async function readJson(directory: FileSystemDirectoryHandle, name: string): Promise<unknown> {
  return JSON.parse(await (await (await directory.getFileHandle(name)).getFile()).text())
}
async function writeFile(directory: FileSystemDirectoryHandle, name: string, content: string) {
  const stream = await (await directory.getFileHandle(name, { create: true })).createWritable()
  try {
    await stream.write(content)
    await stream.close()
  } catch (error) {
    await stream.abort().catch(() => undefined)
    throw error
  }
}
const removeFile = (directory: FileSystemDirectoryHandle, name: string) =>
  directory.removeEntry?.(name).catch(() => undefined)

/** Export remains v3. Only the internal OPFS layout uses immutable message files. */
export async function readOpfsSnapshot(directory: FileSystemDirectoryHandle): Promise<unknown> {
  let raw: unknown
  try {
    raw = await readJson(directory, 'save.json')
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return undefined
    throw error
  }
  if (!raw || typeof raw !== 'object' || !('format' in raw)) return raw
  const manifest = manifestSchema.parse(raw)
  const messages: unknown[] = []
  // Bound open file handles when restoring a large archive.
  for (let offset = 0; offset < manifest.messages.length; offset += 16) {
    const batch = await Promise.all(
      manifest.messages.slice(offset, offset + 16).map(async (ref) => {
        const raw = await readJson(directory, ref.file)
        const message = z.record(z.string(), z.unknown()).parse(raw)
        if (
          (message.id !== undefined && message.id !== ref.id) ||
          (message.archiveId !== undefined && message.archiveId !== ref.archiveId)
        )
          throw new Error('OPFS 消息文件与目录记录不一致。')
        return {
          ...message,
          id: ref.id,
          archiveId: ref.archiveId,
          content:
            message.content ??
            JSON.stringify(
              message.reply && typeof message.reply === 'object'
                ? 'value' in message.reply
                  ? message.reply.value
                  : undefined
                : message.partial &&
                    typeof message.partial === 'object' &&
                    'value' in message.partial
                  ? message.partial.value
                  : '',
            ),
        }
      }),
    )
    messages.push(...batch)
  }
  const settings = z.record(z.string(), z.unknown()).parse(manifest.data.settings)
  const bgImage = manifest.backgroundFile
    ? await (await (await directory.getFileHandle(manifest.backgroundFile)).getFile()).text()
    : ''
  return { ...manifest.data, messages, settings: { ...settings, bgImage } }
}

export class OpfsSnapshotWriter {
  private background?: { image: string; file: string }

  async write(
    directory: FileSystemDirectoryHandle,
    data: SaveFile,
    changedIds?: string[],
    preserveFiles = false,
  ) {
    let previous: Manifest | undefined
    try {
      previous = manifestSchema.parse(await readJson(directory, 'save.json'))
    } catch {
      // A legacy or unreadable save is handled by initializeStorage before this write.
    }
    const refs = new Map(changedIds === undefined ? [] : previous?.messages.map((r) => [r.id, r]))
    const archiveIds = new Set(data.archives.map((a) => a.id))
    for (const [id, ref] of refs) if (!archiveIds.has(ref.archiveId)) refs.delete(id)
    for (const id of changedIds ?? []) refs.delete(id)
    const created: string[] = []
    const known = new Set(previous?.messages.map((ref) => ref.file))
    let committed = false
    try {
      for (let offset = 0; offset < data.messages.length; offset += 16) {
        const results = await Promise.allSettled(
          data.messages.slice(offset, offset + 16).map(async (message) => {
            // The structured value is authoritative; avoid storing its JSON text twice.
            const packed: Partial<StoredMessage> = { ...message }
            delete packed.id
            delete packed.archiveId
            const value = message.reply?.value ?? message.partial?.value
            if (value && message.content === JSON.stringify(value)) delete packed.content
            const content = JSON.stringify(packed)
            const hash = crypto.subtle
              ? [
                  ...new Uint8Array(
                    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)),
                  ),
                ]
                  .map((byte) => byte.toString(16).padStart(2, '0'))
                  .join('')
              : crypto.randomUUID()
            const file = `message-${hash}.json`
            if (!known.has(file)) {
              known.add(file)
              created.push(file)
              await writeFile(directory, file, content)
            }
            refs.set(message.id, { id: message.id, archiveId: message.archiveId, file })
          }),
        )
        const failure = results.find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
      }
      let backgroundFile: string | undefined
      if (data.settings.bgImage) {
        if (
          this.background?.image === data.settings.bgImage &&
          this.background.file === previous?.backgroundFile
        )
          backgroundFile = this.background.file
        else {
          backgroundFile = `background-${crypto.randomUUID()}.txt`
          created.push(backgroundFile)
          await writeFile(directory, backgroundFile, data.settings.bgImage)
          this.background = { image: data.settings.bgImage, file: backgroundFile }
        }
      }
      const manifest: Manifest = {
        format: OPFS_FORMAT,
        data: { ...data, messages: undefined, settings: { ...data.settings, bgImage: '' } },
        messages: [...refs.values()],
        backgroundFile,
      }
      // Commit the directory last; the old directory and its files remain valid until close.
      await writeFile(directory, 'save.json', JSON.stringify(manifest))
      committed = true
      const retained = new Set([...refs.values()].map((r) => r.file))
      if (backgroundFile) retained.add(backgroundFile)
      const obsolete = [...(previous?.messages.map((r) => r.file) ?? []), previous?.backgroundFile]
      if (!preserveFiles)
        await Promise.all(
          obsolete
            .filter((file): file is string => !!file && !retained.has(file))
            .map((file) => removeFile(directory, file)),
        )
    } finally {
      if (!committed) await Promise.all(created.map((file) => removeFile(directory, file)))
    }
  }
}
