import Dexie, { type Table } from 'dexie'
import { OpfsPersistence } from '../opfs'
import { serializeSave } from './serialization'
import {
  type Archive,
  type Channel,
  type Persona,
  type Settings,
  type StoredMessage,
} from '../types'

export class YanJuDatabase extends Dexie {
  archives!: Table<Archive, string>
  messages!: Table<StoredMessage, string>
  channels!: Table<Channel, string>
  personas!: Table<Persona, string>
  settings!: Table<Settings, string>
  readonly persistence: OpfsPersistence
  constructor(name = 'yanju-v3') {
    super(name)
    this.persistence = new OpfsPersistence(name, () => serializeSave(this))
    this.version(3).stores({
      archives: 'id,updatedAt',
      messages: 'id,archiveId,[archiveId+sequence]',
      channels: 'id,createdAt',
      personas: 'id,createdAt',
      settings: 'id',
    })
    this.use({
      stack: 'dbcore',
      name: 'opfs-persistence',
      create: (core) => ({
        ...core,
        transaction: (stores, mode, options) => {
          const transaction = core.transaction(stores, mode, options)
          if (mode === 'readwrite')
            (transaction as IDBTransaction).addEventListener('complete', () =>
              this.persistence.markDirty(),
            )
          return transaction
        },
      }),
    })
  }
}
export const db = new YanJuDatabase()
