import { defaults, newPersona } from '../types'
import { createArchive } from './archives'
import { db, type YanJuDatabase } from './database'
import { importSave } from './save'

const initializing = new WeakMap<YanJuDatabase, Promise<void>>()
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
    if (!(await database.settings.get('app'))) await database.settings.put({ ...defaults })
    if (!(await database.personas.count())) {
      const persona = newPersona()
      await database.personas.add(persona)
      await database.settings.update('app', { activePersonaId: persona.id })
    }
    if (!(await database.archives.count())) await createArchive(undefined, database)
    await database.messages
      .filter((m) => m.status === 'partial')
      .modify({ status: 'cancelled', error: '上次生成已中断，已保留收到的内容，可重试。' })
    await database.persistence.start()
  })().catch((error) => {
    initializing.delete(database)
    throw error
  })
  initializing.set(database, initialization)
  return initialization
}
