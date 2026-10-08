import { validateForum, validateNarrative } from '../schemas'
import type { Archive, StoredMessage, Summary } from '../types'
import { db } from './database'

export const archiveMessages = (id: string, database = db) =>
  database.messages.where('archiveId').equals(id).sortBy('sequence')

/** Appends preserve a summary's coverage; edits to its covered prefix invalidate it. */
export function revise(archive: Archive, invalidate = false): Archive {
  const revision = archive.revision + 1
  return {
    ...archive,
    revision,
    updatedAt: Date.now(),
    lastUsage: undefined,
    summary: invalidate ? undefined : archive.summary && { ...archive.summary, revision },
    compactionError: undefined,
  }
}
export async function appendMessage(message: StoredMessage, expectedRevision?: number) {
  await db.transaction('rw', db.archives, db.messages, async () => {
    const archive = await db.archives.get(message.archiveId)
    if (!archive || (expectedRevision !== undefined && archive.revision !== expectedRevision))
      throw new Error('存档已在其他窗口修改，请重新载入后重试。')
    await db.messages.put(message)
    const updated = revise(archive)
    if (message.usage) updated.lastUsage = message.usage
    await db.archives.put(updated)
  })
}
export async function editMessage(id: string, content: string) {
  await db.transaction('rw', db.archives, db.messages, async () => {
    const message = await db.messages.get(id)
    if (!message) throw new Error('消息不存在')
    const archive = await db.archives.get(message.archiveId)
    if (!archive) throw new Error('存档不存在')
    let next: StoredMessage = {
      ...message,
      content,
      rawContent: undefined,
      correction: undefined,
      partial: undefined,
      error: undefined,
      status: 'complete',
    }
    if (message.role === 'assistant' && message.reply) {
      const parsed: unknown = JSON.parse(content)
      next = {
        ...next,
        reply:
          message.reply.kind === 'narrative'
            ? { kind: 'narrative', value: validateNarrative(parsed) }
            : { kind: 'forum', value: validateForum(parsed) },
      }
    } else if (message.role === 'assistant') next = { ...next, kind: 'text' }
    await db.messages.put(next)
    const all = await archiveMessages(archive.id)
    const coveredIndex = all.findIndex((m) => m.id === archive.summary?.coveredThroughId)
    await db.archives.put(
      revise(archive, !!archive.summary && all.findIndex((m) => m.id === id) <= coveredIndex),
    )
  })
}

export async function commitSummary(archiveId: string, revision: number, summary: Summary) {
  await db.transaction('rw', db.archives, async () => {
    const archive = await db.archives.get(archiveId)
    if (!archive || archive.revision !== revision)
      throw new Error('压缩期间存档有变更，摘要未提交。')
    await db.archives.update(archiveId, { summary, compactionError: undefined })
  })
}
