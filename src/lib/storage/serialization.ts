import type { YanJuDatabase } from './database'
import { defaults, type SaveFile } from '../types'

export async function serializeSave(database: YanJuDatabase): Promise<SaveFile> {
  return database.transaction(
    'r',
    database.archives,
    database.messages,
    database.channels,
    database.personas,
    database.settings,
    async () => ({
      version: 3,
      exportedAt: new Date().toISOString(),
      archives: await database.archives.toArray(),
      messages: await database.messages.toArray(),
      channels: await database.channels.toArray(),
      masks: await database.personas.toArray(),
      settings: (await database.settings.get('app')) ?? defaults,
    }),
  )
}
