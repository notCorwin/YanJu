import { z } from 'zod'
import { db, exportSave, importSave, normalizeImport } from './storage'
import type { SaveFile } from './types'

const metadata = z.object({
  format: z.literal('yanju-checkpoint-v1'),
  id: z.uuid(),
  name: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
})
export type CheckpointInfo = z.infer<typeof metadata>
export interface Checkpoint extends CheckpointInfo {
  data: SaveFile
}

async function directory() {
  if (typeof navigator.storage?.getDirectory !== 'function')
    throw new Error('当前浏览器不支持 OPFS，无法保存 Checkpoint。')
  return (
    await (await navigator.storage.getDirectory()).getDirectoryHandle('yanju-v3', { create: true })
  ).getDirectoryHandle('checkpoints', { create: true })
}
const locked = <T>(operation: () => Promise<T>): Promise<T> =>
  navigator.locks ? navigator.locks.request('yanju-checkpoints', operation) : operation()
const fileName = (id: string) => `${z.uuid().parse(id)}.json`
const info = (value: unknown) => metadata.parse(value)
export function parseCheckpoint(value: unknown): Checkpoint {
  const envelope = z.object({ data: z.unknown() }).parse(value)
  return { ...info(value), data: normalizeImport(envelope.data) }
}

async function writeCheckpoint(checkpoint: Checkpoint) {
  info(checkpoint)
  const dir = await directory()
  const file = await dir.getFileHandle(fileName(checkpoint.id), { create: true })
  let writer: FileSystemWritableFileStream | undefined
  try {
    writer = await file.createWritable()
    await writer.write(JSON.stringify(checkpoint))
    await writer.close()
  } catch (error) {
    await writer?.abort().catch(() => undefined)
    await dir.removeEntry(fileName(checkpoint.id)).catch(() => undefined)
    throw error
  }
  return info(checkpoint)
}

export const listCheckpoints = () =>
  locked(async () => {
    const result: CheckpointInfo[] = []
    const dir = await directory()
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file' || !name.endsWith('.json')) continue
      const data = info(JSON.parse(await (await handle.getFile()).text()))
      if (fileName(data.id) !== name) throw new Error('Checkpoint 文件与索引不一致。')
      result.push(data)
    }
    return result.sort((a, b) => b.createdAt - a.createdAt)
  })
export const readCheckpoint = (id: string) =>
  locked(async (): Promise<Checkpoint> => {
    const file = await (await directory()).getFileHandle(fileName(id))
    const parsed = parseCheckpoint(JSON.parse(await (await file.getFile()).text()))
    if (parsed.id !== id) throw new Error('Checkpoint 文件与索引不一致。')
    return parsed
  })
export const createCheckpoint = (name: string) =>
  locked(async () =>
    writeCheckpoint({
      format: 'yanju-checkpoint-v1',
      id: crypto.randomUUID(),
      name,
      createdAt: Date.now(),
      data: await exportSave(),
    }),
  )
/** Import stores a new immutable OPFS checkpoint; it does not replace the working database. */
export const importCheckpoint = (input: unknown) =>
  locked(async () => {
    const parsed = parseCheckpoint(input)
    return writeCheckpoint({ ...parsed, id: crypto.randomUUID() })
  })
export const deleteCheckpoint = (id: string) =>
  locked(async () => (await directory()).removeEntry(fileName(id)))
export async function restoreCheckpoint(id: string) {
  const checkpoint = await readCheckpoint(id)
  const data = await importSave(checkpoint.data)
  const persistence = await db.persistence.flush()
  return { data, persistence }
}
