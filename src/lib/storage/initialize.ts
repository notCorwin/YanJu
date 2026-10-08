import { activeArchiveOperations } from '@/lib/operations'
import { createArchive } from '@/lib/storage/archives'
import { db, YanJuDatabase } from '@/lib/storage/database'
import { importSave } from '@/lib/storage/save'
import { defaults, newPersona } from '@/lib/types'

export const initializing = new WeakMap<YanJuDatabase, Promise<void>>()

export function initializeStorage(database = db) {
  const pending = initializing.get(database)
  if (pending) return pending
  const initialization = (async () => {
    await database.open()
    if (!(await database.settings.get('app')) && !(await database.archives.count())) {
      try {
        const saved = await database.persistence.read()
        if (saved) await importSave(saved, database, true)
      } catch (error) {
        database.persistence.preserveUnreadableSave(error)
      }
    }
    if (!(await database.settings.get('app')))
      await database.settings.put({ ...defaults, migrated: true })
    if (!(await database.personas.count())) {
      const persona = newPersona()
      await database.personas.add(persona)
      await database.settings.update('app', { activePersonaId: persona.id })
    }
    if (!(await database.archives.count())) await createArchive(undefined, database)
    const active = await activeArchiveOperations(database)
    await database.messages
      .filter((m) => m.status === 'partial' && !active.has(m.archiveId))
      .modify({ status: 'cancelled', error: '上次生成已中断，已保留收到的内容，可重试。' })
    await database.tasks
      .filter((t) => t.status === 'partial' && !active.has(t.archiveId))
      .modify({ status: 'cancelled', error: '上次任务已中断，可重试。' })
    await database.requests
      .filter((r) => r.status === 'partial' && (r.archiveId === null || !active.has(r.archiveId)))
      .modify({ status: 'cancelled', error: '上次请求已中断。' })
    await database.persistence.start()
  })().catch((error) => {
    initializing.delete(database)
    throw error
  })
  initializing.set(database, initialization)
  return initialization
}
