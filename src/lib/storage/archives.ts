import { defaultStoryContent } from '@/lib/game-content'
import opening from '@/content/opening.txt?raw'
import { db } from '@/lib/storage/database'
import { archiveMessages } from '@/lib/storage/messages'
import { remapMessage, remapReferences } from '@/lib/storage/references'
import { exportSave } from '@/lib/storage/save'
import { refreshStory } from '@/lib/storage/story'
import { newPersona, type Archive, type SaveFile, type StoredMessage } from '@/lib/types'

export function createArchiveData(name = '新的篇章'): { archive: Archive; opening: StoredMessage } {
  const now = Date.now()
  const id = crypto.randomUUID()
  const archive: Archive = {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    draft: '',
    content: defaultStoryContent(),
  }
  const msg: StoredMessage = {
    id: crypto.randomUUID(),
    archiveId: id,
    role: 'assistant',
    content: opening,
    kind: 'opening',
    status: 'complete',
    createdAt: now,
    sequence: 0,
  }
  return { archive, opening: msg }
}

export async function createArchive(name?: string, database = db) {
  const data = createArchiveData(name)
  const settings = await database.settings.get('app')
  const persona = settings?.activePersonaId
    ? await database.personas.get(settings.activePersonaId)
    : newPersona()
  data.archive.userName = persona?.name ?? '沈辞玉'
  data.archive.persona = persona
  data.archive.content = defaultStoryContent(settings?.bgImage)
  await database.transaction(
    'rw',
    [
      ...database.gameTables,
      database.archives,
      database.messages,
      database.settings,
      database.storyStates,
      database.storyEvents,
    ],
    async () => {
      await database.archives.add(data.archive)
      await database.messages.add(data.opening)
      await refreshStory(database, data.archive)
      await database.settings.update('app', { activeArchiveId: data.archive.id })
    },
  )
  return data.archive
}

export function copyArchiveData(source: Archive, messages: StoredMessage[], name: string) {
  const id = crypto.randomUUID()
  const ids = new Map([
    [source.id, id],
    ...messages.map((m): [string, string] => [m.id, crypto.randomUUID()]),
  ])
  const covered = source.summary && ids.get(source.summary.coveredThroughId)
  const archive: Archive = {
    ...remapReferences(source, ids),
    id,
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 0,
    draft: '',
    compactionError: undefined,
    summary:
      covered && source.summary?.revision === source.revision
        ? { ...source.summary, coveredThroughId: covered, revision: 0 }
        : undefined,
  }
  return {
    archive,
    messages: messages.map((m, sequence) => ({ ...remapMessage(m, ids), archiveId: id, sequence })),
  }
}

export async function forkArchive(id: string, throughId: string, database = db) {
  return database.transaction(
    'rw',
    [
      ...database.gameTables,
      database.archives,
      database.messages,
      database.settings,
      database.storyStates,
      database.storyEvents,
    ],
    async () => {
      const archive = await database.archives.get(id)
      if (!archive) throw new Error('存档不存在。')
      const all = await archiveMessages(id, database)
      const end = all.findIndex((m) => m.id === throughId)
      if (end < 0) throw new Error('消息不存在。')
      const copy = copyArchiveData(archive, all.slice(0, end + 1), `${archive.name} · 分支`)
      await database.archives.add(copy.archive)
      await database.messages.bulkAdd(copy.messages)
      await refreshStory(database, copy.archive)
      await database.settings.update('app', { activeArchiveId: copy.archive.id })
      return copy.archive
    },
  )
}

export async function exportArchive(id: string, database = db): Promise<SaveFile> {
  const data = await exportSave(database)
  if (!data.archives.some((a) => a.id === id)) throw new Error('存档不存在。')
  return {
    ...data,
    archives: data.archives.filter((a) => a.id === id),
    messages: data.messages
      .filter((m) => m.archiveId === id)
      .sort((a, b) => a.sequence - b.sequence),
    storyStates: data.storyStates.filter((s) => s.archiveId === id),
    storyEvents: data.storyEvents.filter((e) => e.archiveId === id),
    tasks: data.tasks.filter((t) => t.archiveId === id),
    requests: data.requests.filter((r) => r.archiveId === id),
    history: {
      sessions: data.history.sessions.filter((s) => s.id === id),
      branches: data.history.branches.filter((v) => v.archiveId === id),
      nodes: data.history.nodes.filter((v) => v.archiveId === id),
      contexts: data.history.contexts.filter((v) => v.archiveId === id),
      messageVersions: data.history.messageVersions.filter((v) => v.archiveId === id),
      taskVersions: data.history.taskVersions.filter((v) => v.archiveId === id),
      stateVersions: data.history.stateVersions.filter((v) => v.archiveId === id),
      slots: data.history.slots.filter((v) => v.archiveId === id),
    },
    settings: { ...data.settings, activeArchiveId: id },
  }
}
