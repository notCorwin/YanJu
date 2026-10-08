import opening from '@/content/opening.txt?raw'
import type { Archive, StoredMessage } from '../types'
import { db } from './database'

export function createArchiveData(name = '新的篇章'): { archive: Archive; opening: StoredMessage } {
  const now = Date.now()
  const id = crypto.randomUUID()
  const archive: Archive = { id, name, createdAt: now, updatedAt: now, revision: 0, draft: '' }
  const msg: StoredMessage = {
    id: crypto.randomUUID(),
    archiveId: id,
    role: 'assistant',
    content: opening,
    kind: 'text',
    status: 'complete',
    createdAt: now,
    sequence: 0,
  }
  return { archive, opening: msg }
}
export async function createArchive(name?: string, database = db) {
  const data = createArchiveData(name)
  await database.transaction(
    'rw',
    database.archives,
    database.messages,
    database.settings,
    async () => {
      await database.archives.add(data.archive)
      await database.messages.add(data.opening)
      await database.settings.update('app', { activeArchiveId: data.archive.id })
    },
  )
  return data.archive
}

export async function renameArchive(id: string, name: string, database = db) {
  if (!name.trim()) throw new Error('请输入存档名称。')
  await database.archives.update(id, { name: name.trim() })
}

export async function removeArchive(id: string, database = db) {
  return database.transaction('rw', database.archives, database.messages, async () => {
    await database.messages.where('archiveId').equals(id).delete()
    await database.archives.delete(id)
    return database.archives.toCollection().first()
  })
}

export async function resetArchive(id: string, database = db) {
  await database.transaction('rw', database.archives, database.messages, async () => {
    const archive = await database.archives.get(id)
    if (!archive) throw new Error('存档不存在。')
    const data = createArchiveData(archive.name)
    await database.messages.where('archiveId').equals(id).delete()
    await database.archives.put({ ...data.archive, id, createdAt: archive.createdAt })
    await database.messages.add({ ...data.opening, archiveId: id })
  })
}
