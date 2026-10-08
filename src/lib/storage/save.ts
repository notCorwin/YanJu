import { withImportOperation } from '@/lib/operations'
import { type PersistenceSnapshot } from '@/lib/opfs'
import { createArchiveData } from '@/lib/storage/archives'
import { db, YanJuDatabase } from '@/lib/storage/database'
import { remapId, remapMessage, remapReferences } from '@/lib/storage/references'
import { normalizeImport } from '@/lib/storage/serialization'
import { refreshStory } from '@/lib/storage/story'
import { rebuildStory } from '@/lib/story'
import { defaults, newPersona, type SaveFile, type StoredMessage } from '@/lib/types'

export async function importSave(
  input: unknown,
  database = db,
  restore = false,
  mode: 'replace' | 'merge' = 'replace',
) {
  const data = normalizeImport(input, restore)
  await withImportOperation(
    () =>
      database.transaction(
        'rw',
        [
          database.archives,
          database.messages,
          database.channels,
          database.personas,
          database.settings,
          database.storyStates,
          database.storyEvents,
          database.tasks,
          database.requests,
        ],
        async () => {
          if (mode === 'merge') {
            const ids = new Map<string, string>()
            for (const [incoming, table] of [
              [data.archives, database.archives],
              [data.messages, database.messages],
              [data.channels, database.channels],
              [data.masks, database.personas],
              [data.tasks, database.tasks],
              [data.requests, database.requests],
            ] as const) {
              const taken = new Set(await table.toCollection().primaryKeys())
              for (const item of incoming)
                ids.set(item.id, taken.has(item.id) ? crypto.randomUUID() : item.id)
            }
            data.archives = data.archives.map((a) => ({
              ...remapReferences(a, ids),
              name: ids.get(a.id) !== a.id ? `${a.name} · 导入` : a.name,
            }))
            data.messages = data.messages.map((m) => remapMessage(m, ids))
            data.channels = data.channels.map((c) => remapReferences(c, ids))
            data.masks = data.masks.map((p) => remapReferences(p, ids))
            data.tasks = data.tasks.map((t) => ({
              ...remapReferences(t, ids),
              input: remapReferences(t.input, ids),
            }))
            data.requests = data.requests.map((r) => ({
              ...r,
              id: ids.get(r.id)!,
              ownerId: r.ownerId === null ? null : remapId(r.ownerId, ids),
              archiveId: r.archiveId === null ? null : ids.get(r.archiveId)!,
              channel: { ...r.channel, id: remapId(r.channel.id, ids) },
              usage: r.usage && remapReferences(r.usage, ids),
            }))
            data.storyStates = []
            data.storyEvents = []
            for (const archive of data.archives) {
              const projected = rebuildStory(
                archive,
                data.messages.filter((m) => m.archiveId === archive.id),
              )
              data.storyStates.push(projected.story)
              data.storyEvents.push(...projected.events)
            }
            data.settings = {
              ...((await database.settings.get('app')) ?? defaults),
              activeArchiveId:
                ids.get(data.settings.activeArchiveId) ??
                data.archives[0]?.id ??
                (await database.settings.get('app'))?.activeArchiveId ??
                '',
            }
          } else
            await Promise.all([
              database.archives.clear(),
              database.messages.clear(),
              database.channels.clear(),
              database.personas.clear(),
              database.storyStates.clear(),
              database.storyEvents.clear(),
              database.tasks.clear(),
              database.requests.clear(),
            ])
          await database.archives.bulkPut(data.archives)
          await database.messages.bulkPut(data.messages)
          await database.storyStates.bulkPut(data.storyStates)
          await database.storyEvents.bulkPut(data.storyEvents)
          await database.tasks.bulkPut(data.tasks)
          await database.requests.bulkPut(data.requests)
          await database.channels.bulkPut(data.channels)
          await database.personas.bulkPut(data.masks)
          await database.settings.put(data.settings)
          if (!(await database.personas.count())) {
            const persona = newPersona()
            await database.personas.add(persona)
            data.masks.push(persona)
            data.settings.activePersonaId = persona.id
            await database.settings.update('app', { activePersonaId: persona.id })
          }
          if (!(await database.archives.count())) {
            const created = createArchiveData()
            await database.archives.add(created.archive)
            await database.messages.add(created.opening)
            await refreshStory(database, created.archive)
            data.archives.push(created.archive)
            data.messages.push(created.opening)
            const projection = rebuildStory(created.archive, [created.opening])
            data.storyStates.push(projection.story)
            data.storyEvents.push(...projection.events)
            data.settings.activeArchiveId = created.archive.id
            await database.settings.update('app', { activeArchiveId: created.archive.id })
          }
        },
      ),
    database,
  )
  return data
}

export async function exportSave(database = db, messageIds?: string[]): Promise<SaveFile> {
  return database.transaction(
    'r',
    [
      database.archives,
      database.messages,
      database.channels,
      database.personas,
      database.settings,
      database.storyStates,
      database.storyEvents,
      database.tasks,
      database.requests,
    ],
    async () => ({
      version: 3,
      exportedAt: new Date().toISOString(),
      archives: await database.archives.toArray(),
      messages:
        messageIds === undefined
          ? await database.messages.toArray()
          : (await database.messages.bulkGet(messageIds)).filter((m): m is StoredMessage => !!m),
      channels: await database.channels.toArray(),
      masks: await database.personas.toArray(),
      settings: (await database.settings.get('app')) ?? defaults,
      storyStates: await database.storyStates.toArray(),
      storyEvents: await database.storyEvents.toArray(),
      tasks: await database.tasks.toArray(),
      requests: await database.requests.toArray(),
    }),
  )
}

export async function readPersistenceSnapshot(
  database: YanJuDatabase,
  ids?: string[],
): Promise<PersistenceSnapshot> {
  return database.transaction(
    'r',
    [
      database.archives,
      database.messages,
      database.channels,
      database.personas,
      database.settings,
      database.persistenceChanges,
      database.storyStates,
      database.storyEvents,
      database.tasks,
      database.requests,
    ],
    async () => {
      const journal = await database.persistenceChanges.toArray()
      const messageIds =
        ids === undefined || journal.some((entry) => entry.id === 'all')
          ? undefined
          : [
              ...new Set([
                ...ids,
                ...journal
                  .filter((entry) => entry.id.startsWith('message:'))
                  .map((entry) => entry.id.slice('message:'.length)),
              ]),
            ]
      const data = await exportSave(database, messageIds)
      return {
        data,
        messageIds,
        committed: () =>
          database.transaction('rw', database.persistenceChanges, async () => {
            const current = await database.persistenceChanges.bulkGet(
              journal.map((entry) => entry.id),
            )
            const acknowledged = journal.filter(
              (entry, index) => current[index]?.token === entry.token,
            )
            await database.persistenceChanges.bulkDelete(acknowledged.map((entry) => entry.id))
          }),
      }
    },
  )
}
