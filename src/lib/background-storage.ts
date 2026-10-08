import type { YanJuDatabase } from './db'
import type { BackgroundImageRef, Settings } from './types'
import { dataUrlToImage, files, withStorageLock, type FileStorage } from './file-storage'

export type PreparedBackground = Pick<Settings, 'bgImage' | 'bgImageRef'>

/** Call from within the shared storage lock, before any IndexedDB transaction. */
export async function prepareBackground(
  image: Blob | string,
  storage: FileStorage = files,
  root = 'yanju-v2',
): Promise<PreparedBackground> {
  const blob = typeof image === 'string' ? dataUrlToImage(image) : image
  if (!blob) {
    if (typeof image === 'string' && !image) return { bgImage: '' }
    throw new Error('背景图片无法解码，请选择图片文件。')
  }
  const id = crypto.randomUUID()
  try {
    await storage.write(`${root}/backgrounds/${id}`, blob)
    return { bgImage: '', bgImageRef: { id, mimeType: blob.type, size: blob.size } }
  } catch (error) {
    await storage.remove(`${root}/backgrounds/${id}`).catch(() => undefined)
    throw error
  }
}

/** Materialize the bytes under the lock before creating a URL or exporting JSON. */
export async function readBackground(
  ref: BackgroundImageRef,
  storage: FileStorage = files,
  root = 'yanju-v2',
) {
  try {
    const blob = await storage.read(`${root}/backgrounds/${ref.id}`)
    if (blob.size !== ref.size) throw new Error('图片文件不完整')
    return blob.slice(0, blob.size, ref.mimeType)
  } catch (cause) {
    throw new Error('背景图片读取失败。请重试，或导入含背景图片的完整存档。', { cause })
  }
}

export async function replaceBackground(database: YanJuDatabase, image: File | undefined) {
  if (image && !image.type.startsWith('image/')) throw new Error('请选择图片文件。')
  return database.mutate(async (tx) => {
    if (!(await tx.settings.get('app'))) throw new Error('本地设置尚未打开。')
    const prepared = image
      ? await prepareBackground(image, database.storage, database.root)
      : { bgImage: '' }
    if (prepared.bgImageRef) tx.trackFile(`${database.root}/backgrounds/${prepared.bgImageRef.id}`)
    await tx.settings.update('app', { bgImageRef: undefined, ...prepared })
  })
}

export function resolveBackground(ref: BackgroundImageRef, storage: FileStorage = files) {
  return withStorageLock(() => readBackground(ref, storage))
}
