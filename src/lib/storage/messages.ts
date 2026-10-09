import { captureGameNode, prepareHistoryEdit } from '@/lib/game-history'
import { effectsSchema } from '@/lib/domain-schema'
import { validateForum, validateNarrative } from '@/lib/schemas'
import { db } from '@/lib/storage/database'
import { refreshStory } from '@/lib/storage/story'
import { applyMessage, rebuildStory } from '@/lib/story'
import { type Archive, type StoredMessage, type Summary } from '@/lib/types'
import Dexie from 'dexie'
import { z } from 'zod'
import { withArchiveOperation } from '@/lib/operations'
import type { YanJuDatabase } from '@/lib/storage/database'

export const archiveMessages = (id: string, database = db) =>
  database.messages.where('archiveId').equals(id).sortBy('sequence')

export async function recentArchiveMessages(id: string, limit: number, database = db) {
  const collection = database.messages
    .where('[archiveId+sequence]')
    .between([id, Dexie.minKey], [id, Dexie.maxKey])
  const [count, messages] = await Promise.all([
    collection.count(),
    collection.clone().reverse().limit(limit).toArray(),
  ])
  return { count, messages: messages.reverse() }
}

export async function contextArchiveMessages(archive: Archive, database = db) {
  const boundary =
    archive.summary?.revision === archive.revision
      ? await database.messages.get(archive.summary.coveredThroughId)
      : undefined
  if (!boundary || boundary.archiveId !== archive.id) return archiveMessages(archive.id, database)
  return database.messages
    .where('[archiveId+sequence]')
    .between([archive.id, boundary.sequence], [archive.id, Dexie.maxKey])
    .toArray()
}

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

export async function appendMessage(
  message: StoredMessage,
  expectedRevision?: number,
  expectedNodeId?: string,
  expectedOperationOwner?: string,
) {
  await db.transaction('rw', [...db.gameTables, db.operations], async () => {
    if (
      expectedOperationOwner &&
      (await db.operations.get(message.archiveId))?.owner !== expectedOperationOwner
    )
      throw new Error('会话操作已失效，旧回复未写入。')
    const archive = await db.archives.get(message.archiveId)
    if (!archive || (expectedRevision !== undefined && archive.revision !== expectedRevision))
      throw new Error('存档已在其他窗口修改，请重新载入后重试。')
    if (expectedNodeId && (await db.sessions.get(message.archiveId))?.nodeId !== expectedNodeId)
      throw new Error('剧情起点已改变，旧回复未写入。')
    const existing = await db.messages.get(message.id)
    if (existing?.status === 'complete') {
      if (JSON.stringify(existing) === JSON.stringify(message)) return
      throw new Error('消息 ID 已提交，不能重复覆盖。')
    }
    if (
      await db.messages
        .where('[archiveId+sequence]')
        .equals([message.archiveId, message.sequence])
        .filter((m) => m.id !== message.id)
        .count()
    )
      throw new Error('消息序号已被其他窗口占用，请重新载入后重试。')
    if (message.status === 'complete' && !message.stale)
      applyMessage(
        rebuildStory(archive, await archiveMessages(archive.id)).story,
        structuredClone(message),
      )
    await db.messages.put(message)
    const updated = revise(archive)
    if (message.usage) updated.lastUsage = message.usage
    await db.archives.put(updated)
    await refreshStory(db, updated)
  })
  return message
}

export async function editMessage(id: string, content: string) {
  await db.transaction(
    'rw',
    [...db.gameTables, db.archives, db.messages, db.storyStates, db.storyEvents],
    async () => {
      const message = await db.messages.get(id)
      if (!message) throw new Error('消息不存在')
      const archive = await db.archives.get(message.archiveId)
      if (!archive) throw new Error('存档不存在')
      let next: StoredMessage = {
        ...message,
        content,
        rawContent: undefined,
        requestContext: undefined,
        stale: false,
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
      } else if (message.interaction) {
        const text = z.string().refine((value) => !!value.trim(), '内容不能为空')
        const interaction = z
          .discriminatedUnion('kind', [
            z.strictObject({
              kind: z.literal('phone'),
              contactRef: text,
              userText: text,
              speaker: text,
              time: text,
              text,
            }),
            z.strictObject({
              kind: z.literal('forum'),
              postId: text,
              replyTo: text,
              userText: text,
              author: text,
              time: text,
              content: text,
            }),
          ])
          .parse(JSON.parse(content))
        const user = message.userName ?? archive.userName ?? '你'
        next = {
          ...next,
          interaction,
          content:
            interaction.kind === 'phone'
              ? `${user}：${interaction.userText}\n${interaction.speaker}：${interaction.text}`
              : `${user}：${interaction.userText}\n${interaction.author}：${interaction.content}`,
        }
      } else if (message.effects) {
        const material = z
          .strictObject({ content: z.string().min(1), effects: effectsSchema })
          .parse(JSON.parse(content))
        next = { ...next, ...material }
      } else if (message.role === 'assistant') next = { ...next, kind: message.kind }
      const base = await prepareHistoryEdit(archive, id)
      rebuildStory(base, [
        ...(await archiveMessages(archive.id)).filter((m) => m.sequence < next.sequence),
        next,
      ])
      await db.messages.put(next)
      const all = await archiveMessages(archive.id)
      const coveredIndex = all.findIndex((m) => m.id === archive.summary?.coveredThroughId)
      const updated = revise(
        base,
        !!archive.summary && all.findIndex((m) => m.id === id) <= coveredIndex,
      )
      const tail = all.filter((m) => m.sequence > message.sequence)
      await db.messages.bulkDelete(tail.map((m) => m.id))
      await db.archives.put(updated)
      await refreshStory(db, updated)
      await captureGameNode(db, updated, '编辑剧情', true)
    },
  )
}

export async function commitSummary(archiveId: string, revision: number, summary: Summary) {
  await db.transaction('rw', [...db.gameTables, db.archives], async () => {
    const archive = await db.archives.get(archiveId)
    if (!archive || archive.revision !== revision)
      throw new Error('压缩期间存档有变更，摘要未提交。')
    await db.archives.update(archiveId, { summary, compactionError: undefined })
  })
}

/** A deletion keeps every other record and sequence intact, including later turns. */
export async function deleteMessage(
  id: string,
  expectedRevision?: number,
  expectedEpoch?: number,
  database: YanJuDatabase = db,
) {
  const target = await database.messages.get(id)
  if (!target) throw new Error('消息不存在。')
  await withArchiveOperation(
    target.archiveId,
    () =>
      database.transaction('rw', database.gameTables, async () => {
        const message = await database.messages.get(id)
        const archive = await database.archives.get(target.archiveId)
        if (!message || !archive) throw new Error('消息或篇章已删除。')
        if (
          (expectedRevision !== undefined && archive.revision !== expectedRevision) ||
          (expectedEpoch !== undefined && (archive.navigationEpoch ?? 0) !== expectedEpoch)
        )
          throw new Error('篇章已在其他窗口修改，请重新载入后删除。')
        const updated = {
          ...revise(archive, true),
          deletedMessageIds: [...(archive.deletedMessageIds ?? []), id],
        }
        await database.messages.delete(id)
        await database.archives.put(updated)
        await refreshStory(database, updated, '删除消息', true)
      }),
    database,
  )
}
