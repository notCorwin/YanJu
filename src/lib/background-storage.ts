import type { YanJuDatabase } from './db'
import { blobToDataUrl } from './file-storage'

/** Settings remain in IndexedDB; the atomic OPFS checkpoint includes the image bytes. */
export async function replaceBackground(database: YanJuDatabase, image?: File) {
  if (image && !image.type.startsWith('image/')) throw new Error('请选择图片文件。')
  const bgImage = image ? await blobToDataUrl(image) : ''
  if (!(await database.settings.update('app', { bgImage })))
    throw new Error('本地设置尚未打开。')
  const status = await database.persistence.flush()
  if (status.phase === 'error') throw new Error(status.error || '背景图片尚未完成 OPFS 备份。')
}
