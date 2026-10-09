import { db } from './storage/database'
import type { SaveFile } from './types'

interface DraftUpdate {
  text: string
  navigationEpoch: number
  error?: string
}
const pending = new Map<string, DraftUpdate>()
const listeners = new Set<() => void>()
let writes = Promise.resolve()
const changed = () => listeners.forEach((listener) => listener())
export const subscribeDrafts = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const draftSaveError = () => [...pending.values()].find((item) => item.error)?.error

export function saveDraft(archiveId: string, text: string, navigationEpoch = 0) {
  const update: DraftUpdate = { text, navigationEpoch }
  pending.set(archiveId, update)
  changed()
  writes = writes
    .catch(() => undefined)
    .then(async () => {
      if (pending.get(archiveId) !== update) return
      try {
        await db.transaction('rw', db.archives, async () => {
          const archive = await db.archives.get(archiveId)
          if (archive && (archive.navigationEpoch ?? 0) === navigationEpoch)
            await db.archives.update(archiveId, { draft: text })
        })
        if (pending.get(archiveId) === update) pending.delete(archiveId)
      } catch (error) {
        update.error = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        changed()
      }
    })
  return writes
}
export async function retryDrafts() {
  for (const [id, update] of pending) await saveDraft(id, update.text, update.navigationEpoch)
}
export function withPendingDrafts(data: SaveFile): SaveFile {
  return {
    ...data,
    archives: data.archives.map((archive) => {
      const draft = pending.get(archive.id)
      return draft && draft.navigationEpoch === (archive.navigationEpoch ?? 0)
        ? { ...archive, draft: draft.text }
        : archive
    }),
  }
}
