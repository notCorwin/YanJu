import type {
  Branch,
  GameSession,
  GameContext,
  HistoryNode,
  SaveSlot,
  MessageVersion,
  TaskVersion,
  StateVersion,
} from '@/lib/types'
import { type OperationLease } from '@/lib/operations'
import { OpfsPersistence } from '@/lib/opfs'
import { readPersistenceSnapshot } from '@/lib/storage/save'
import { type StoryEvent, type StoryState } from '@/lib/story'
import type { RequestRecord, TaskRun } from '@/lib/types'
import {
  type Archive,
  type Channel,
  type Persona,
  type Settings,
  type StoredMessage,
} from '@/lib/types'
import Dexie, { type Table } from 'dexie'

export interface PersistenceChange {
  id: string
  token: string
}

export class YanJuDatabase extends Dexie {
  archives!: Table<Archive, string>
  messages!: Table<StoredMessage, string>
  channels!: Table<Channel, string>
  personas!: Table<Persona, string>
  settings!: Table<Settings, string>
  storyStates!: Table<StoryState, string>
  storyEvents!: Table<StoryEvent, string>
  tasks!: Table<TaskRun, string>
  requests!: Table<RequestRecord, string>
  operations!: Table<OperationLease, string>
  persistenceChanges!: Table<PersistenceChange, string>
  sessions!: Table<GameSession, string>
  branches!: Table<Branch, string>
  nodes!: Table<HistoryNode, string>
  contexts!: Table<GameContext, string>
  messageVersions!: Table<MessageVersion, string>
  taskVersions!: Table<TaskVersion, string>
  slots!: Table<SaveSlot, string>
  stateVersions!: Table<StateVersion, string>
  get gameTables(): Table[] {
    return [
      ...this.historyTables,
      this.archives,
      this.messages,
      this.tasks,
      this.storyStates,
      this.storyEvents,
    ]
  }
  get historyTables(): Table[] {
    return [
      this.sessions,
      this.branches,
      this.nodes,
      this.contexts,
      this.messageVersions,
      this.taskVersions,
      this.slots,
      this.stateVersions,
    ]
  }
  readonly persistence: OpfsPersistence
  constructor(name = 'yanju-v4') {
    super(name)
    this.persistence = new OpfsPersistence(name, (ids) => readPersistenceSnapshot(this, ids), true)
    this.version(1).stores({
      archives: 'id,updatedAt',
      messages: 'id,archiveId,[archiveId+sequence]',
      channels: 'id,createdAt',
      personas: 'id,createdAt',
      settings: 'id',
      storyStates: 'archiveId',
      storyEvents: 'id,archiveId,[archiveId+sequence]',
      tasks: 'id,archiveId,createdAt',
    })
    this.version(2).stores({ requests: 'id,archiveId,kind,createdAt,[archiveId+createdAt]' })
    this.version(3).stores({ operations: 'archiveId', persistenceChanges: 'id' })
    this.version(4).stores({
      sessions: 'id',
      branches: 'id,archiveId',
      nodes: 'id,archiveId,branchId',
      contexts: 'id,archiveId',
      messageVersions: 'id,archiveId',
      taskVersions: 'id,archiveId',
      slots: 'id,archiveId,[branchId+kind]',
      stateVersions: 'id,archiveId',
    })
    const changes = new WeakMap<object, { touched: boolean; full: boolean; ids: Set<string> }>()
    this.use({
      stack: 'dbcore',
      name: 'opfs-persistence',
      create: (core) => ({
        ...core,
        transaction: (stores, mode, options) => {
          const tracked =
            mode === 'readwrite' &&
            stores.some((name) => name !== 'operations' && name !== 'persistenceChanges')
          const transaction = core.transaction(
            tracked ? [...new Set([...stores, 'persistenceChanges'])] : stores,
            mode,
            options,
          )
          if (mode === 'readwrite') {
            const change = { touched: false, full: false, ids: new Set<string>() }
            changes.set(transaction, change)
            ;(transaction as IDBTransaction).addEventListener('complete', () => {
              if (change.touched)
                this.persistence.markDirty(change.full ? undefined : [...change.ids])
            })
          }
          return transaction
        },
        table: (name) => {
          const table = core.table(name)
          return {
            ...table,
            mutate: (request) =>
              table.mutate(request).then(async (result) => {
                const change = changes.get(request.trans)
                if (!change || name === 'operations' || name === 'persistenceChanges') return result
                change.touched = true
                const journal = ['metadata']
                if (name === 'messages') {
                  if (request.type === 'deleteRange') {
                    change.full = true
                    journal.push('all')
                  } else {
                    const keys = request.keys ?? result.results
                    if (keys)
                      keys.forEach((key, index) => {
                        if (!result.failures[index] && typeof key === 'string') {
                          change.ids.add(key)
                          journal.push(`message:${key}`)
                        }
                      })
                    else {
                      change.full = true
                      journal.push('all')
                    }
                  }
                }
                // The journal commits in the same transaction. Any tab can finish syncing a tab that closed.
                const written = await core.table('persistenceChanges').mutate({
                  trans: request.trans,
                  type: 'put',
                  values: journal.map((id) => ({ id, token: crypto.randomUUID() })),
                })
                if (written.numFailures) throw new Error('未能记录存档同步状态。')
                return result
              }),
          }
        },
      }),
    })
  }
}

export const db = new YanJuDatabase()
