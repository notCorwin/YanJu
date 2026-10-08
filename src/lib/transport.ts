import { interceptImage, isRoleIntercepted } from '@/content/intercept'
import {
  createUIMessageStream,
  type ChatTransport,
  type DeepPartial,
  type UIMessageStreamWriter,
} from 'ai'
import { calibrate, compactContext, contextBudget } from './context'
import { buildInstructions, modelMessages } from './prompts'
import { channelIsReady, friendlyError, generateReply, summarize } from './provider'
import type { ForumReply, NarrativeReply, RequestKind } from './schemas'
import { sanitizePartial } from './schemas'
import { appendMessage, archiveMessages, commitSummary, db, revise } from './storage'
import type { Archive, Channel, ChatMessage, Persona, StoredMessage, Summary } from './types'

const supersededCompaction = Symbol('supersededCompaction')

export function toChatMessage(message: StoredMessage): ChatMessage {
  const parts: ChatMessage['parts'] = []
  if (message.role === 'user') parts.push({ type: 'text', text: message.content })
  else if (message.reply?.kind === 'narrative')
    parts.push({ type: 'data-narrative', id: 'reply', data: message.reply.value })
  else if (message.reply?.kind === 'forum')
    parts.push({ type: 'data-forum', id: 'reply', data: message.reply.value })
  else if (message.partial?.kind === 'narrative')
    parts.push({
      type: 'data-narrative',
      id: 'reply',
      data: sanitizePartial('narrative', message.partial.value),
    })
  else if (message.partial?.kind === 'forum')
    parts.push({
      type: 'data-forum',
      id: 'reply',
      data: sanitizePartial('forum', message.partial.value),
    })
  else if (message.kind === 'notice') parts.push({ type: 'data-notice', data: message.content })
  else parts.push({ type: 'text', text: message.content })
  return {
    id: message.id,
    role: message.role,
    parts,
    metadata: {
      createdAt: message.createdAt,
      kind: message.kind,
      status: message.status,
      error: message.error,
    },
  }
}

export async function persistCancelledMessage(archiveId: string, message: ChatMessage | undefined) {
  await db.transaction('rw', db.archives, db.messages, async () => {
    const archive = await db.archives.get(archiveId)
    if (!archive) return
    const all = await archiveMessages(archiveId)
    const previous =
      message?.role === 'assistant' ? all.find((m) => m.id === message.id) : undefined
    if (previous?.status === 'complete') return
    const narrative = message?.parts.find((p) => p.type === 'data-narrative')
    const forum = message?.parts.find((p) => p.type === 'data-forum')
    const partial: StoredMessage['partial'] =
      narrative?.type === 'data-narrative'
        ? { kind: 'narrative', value: narrative.data }
        : forum?.type === 'data-forum'
          ? { kind: 'forum', value: forum.data }
          : undefined
    await db.messages.put({
      ...previous,
      id: previous?.id || (message?.role === 'assistant' ? message.id : crypto.randomUUID()),
      archiveId,
      role: 'assistant',
      kind: partial?.kind || (message?.metadata?.kind === 'forum' ? 'forum' : 'narrative'),
      status: 'cancelled',
      createdAt: previous?.createdAt || Date.now(),
      sequence: previous?.sequence ?? (all.at(-1)?.sequence ?? -1) + 1,
      content: partial ? JSON.stringify(partial.value) : '',
      partial,
      error: '已停止生成，已保留收到的内容，可重试。',
    })
    await db.archives.put(revise(archive))
  })
}

async function saveGenerated(message: StoredMessage, revision: number, regenerateFromId?: string) {
  if (!regenerateFromId) return appendMessage(message, revision)
  await db.transaction('rw', db.archives, db.messages, async () => {
    const archive = await db.archives.get(message.archiveId)
    if (!archive || archive.revision !== revision)
      throw new Error('存档已变更，重说结果未覆盖原记录。')
    const all = await archiveMessages(archive.id)
    const start = all.findIndex((m) => m.id === regenerateFromId)
    if (start < 0) throw new Error('找不到重说的消息')
    message.sequence = all[start].sequence
    await db.messages.bulkDelete(all.slice(start).map((m) => m.id))
    await db.messages.put(message)
    const next = revise(archive)
    next.lastUsage = message.usage
    await db.archives.put(next)
  })
}

async function saveRecovery(message: StoredMessage) {
  await db.transaction('rw', db.archives, db.messages, async () => {
    const archive = await db.archives.get(message.archiveId)
    if (!archive) throw new Error('存档不存在，收到的内容仍保留在当前回复中。')
    const all = await archiveMessages(archive.id)
    const previous = all.find((m) => m.id === message.id)
    if (previous?.status === 'complete') return
    await db.messages.put({
      ...message,
      sequence: previous?.sequence ?? (all.at(-1)?.sequence ?? -1) + 1,
    })
    await db.archives.put(revise(archive))
  })
}

export async function compressArchive(
  archive: Archive,
  channel: Channel,
  persona: Persona | undefined,
  messages: StoredMessage[],
  signal: AbortSignal,
  kind: RequestKind,
  progress?: (detail: string) => void,
  force = false,
): Promise<Summary | undefined> {
  try {
    return await compactContext({
      archive,
      channel,
      persona,
      kind,
      messages,
      signal,
      force,
      onProgress: progress,
      summarize: (input, s) => summarize(channel, input, s),
      commit: (s) => commitSummary(archive.id, archive.revision, s),
    })
  } catch (error) {
    if (signal.reason !== supersededCompaction)
      await db.transaction('rw', db.archives, async () => {
        const current = await db.archives.get(archive.id)
        if (current?.revision === archive.revision)
          await db.archives.update(archive.id, { compactionError: friendlyError(error) })
      })
    throw error
  }
}

export class BrowserChatTransport implements ChatTransport<ChatMessage> {
  private compaction?: AbortController

  private async compactAfterReply(
    archiveId: string,
    revision: number,
    channel: Channel,
    persona: Persona | undefined,
    kind: RequestKind,
  ) {
    const controller = new AbortController()
    this.compaction = controller
    try {
      const archive = await db.archives.get(archiveId)
      if (!archive || archive.revision !== revision || controller.signal.aborted) return
      await compressArchive(
        archive,
        channel,
        persona,
        await archiveMessages(archiveId),
        controller.signal,
        kind,
      )
    } catch {
      // Compaction errors live on the archive; the completed reply stays complete and usable.
    } finally {
      if (this.compaction === controller) this.compaction = undefined
      await db.persistence.flush()
    }
  }

  async sendMessages(options: Parameters<ChatTransport<ChatMessage>['sendMessages']>[0]) {
    this.compaction?.abort(supersededCompaction)
    const settings = await db.settings.get('app')
    let archive = await db.archives.get(options.chatId)
    const channel = settings?.activeChannelId
      ? await db.channels.get(settings.activeChannelId)
      : undefined
    const persona = settings?.activePersonaId
      ? await db.personas.get(settings.activePersonaId)
      : undefined
    if (!archive) throw new Error('存档不存在，请创建或选择存档。')
    if (!channel || !channelIsReady(channel))
      throw new Error('请先配置渠道并通过严格结构化与浏览器连接测试。')
    const all = await archiveMessages(archive.id)
    const body = options.body as Record<string, unknown> | undefined
    const regen = typeof body?.regenerateFromId === 'string' ? body.regenerateFromId : undefined
    const regenIndex = regen ? all.findIndex((m) => m.id === regen) : -1
    if (
      regenIndex >= 0 &&
      archive.summary &&
      regenIndex <= all.findIndex((m) => m.id === archive!.summary?.coveredThroughId)
    ) {
      const next = revise(archive, true)
      await db.transaction('rw', db.archives, async () => {
        const current = await db.archives.get(next.id)
        if (current?.revision !== archive!.revision)
          throw new Error('存档已变更，请重新载入后重说。')
        await db.archives.put(next)
      })
      archive = next
    }
    const snapshot = archive
    const messages = regenIndex >= 0 ? all.slice(0, regenIndex) : all
    const lastUser = messages.findLast((m) => m.role === 'user')
    if (!lastUser) throw new Error('没有可回复的用户消息。')
    const kind: RequestKind =
      body?.kind === 'forum' || lastUser.kind === 'forum' ? 'forum' : 'narrative'
    const signal = options.abortSignal ?? new AbortController().signal
    const messageId = crypto.randomUUID()
    const createdAt = Date.now()
    const base: StoredMessage = {
      id: messageId,
      archiveId: snapshot.id,
      role: 'assistant',
      content: '',
      createdAt,
      sequence: (all.at(-1)?.sequence ?? -1) + 1,
      kind,
      status: 'partial',
    }
    let partial: StoredMessage['partial']
    let rawContent = ''
    let correction: string | undefined
    let committed = false
    let checkpointAt = 0
    let pendingCheckpoint = Promise.resolve()
    let completedChannel: Channel | undefined
    const status = (
      writer: UIMessageStreamWriter<ChatMessage>,
      phase: 'compressing' | 'generating' | 'correcting' | 'complete' | 'failed' | 'cancelled',
      detail: string,
    ) => writer.write({ type: 'data-status', id: 'status', data: { phase, detail } })
    return createUIMessageStream<ChatMessage>({
      execute: async ({ writer }) => {
        writer.write({
          type: 'start',
          messageId,
          messageMetadata: { createdAt, kind, status: 'partial' },
        })
        try {
          if (signal.aborted) throw new DOMException('已取消', 'AbortError')
          if (isRoleIntercepted(lastUser.content)) {
            const notice: StoredMessage = {
              ...base,
              kind: 'notice',
              status: 'complete',
              content: interceptImage,
            }
            await saveGenerated(notice, snapshot.revision, regen)
            committed = true
            writer.write({ type: 'data-notice', data: notice.content })
          } else {
            const summary = await compressArchive(
              snapshot,
              channel,
              persona,
              messages,
              signal,
              kind,
              (d) => status(writer, 'compressing', d),
            )
            const estimate = contextBudget(channel, persona, kind, messages, summary)
            if (estimate.mustCompress)
              throw new Error('压缩后仍没有足够上下文，请调整渠道容量或输出上限。')
            status(writer, 'generating', '正在生成严格结构化回复…')
            const result = await generateReply({
              channel,
              kind,
              instructions: buildInstructions(persona, kind),
              messages: modelMessages(messages, summary),
              signal,
              estimatedInput: estimate.estimated,
              onPartial: (value, raw) => {
                rawContent = raw ?? JSON.stringify(value)
                if (kind === 'narrative') {
                  partial = { kind, value: value as DeepPartial<NarrativeReply> }
                  writer.write({ type: 'data-narrative', id: 'reply', data: partial.value })
                } else {
                  partial = { kind, value: value as DeepPartial<ForumReply> }
                  writer.write({ type: 'data-forum', id: 'reply', data: partial.value })
                }
                if (Date.now() - checkpointAt > 500) {
                  checkpointAt = Date.now()
                  pendingCheckpoint = pendingCheckpoint
                    .then(() =>
                      db.transaction('rw', db.archives, db.messages, async () => {
                        const current = await db.archives.get(snapshot.id)
                        if (current?.revision === snapshot.revision)
                          await db.messages.put({
                            ...base,
                            partial,
                            correction,
                            content: partial ? JSON.stringify(partial.value) : '',
                            rawContent,
                          })
                      }),
                    )
                    .catch(() => {
                      /* Final commit reports persistent storage failures. */
                    })
                }
              },
              onCorrection: (detail, text) => {
                correction = text
                status(writer, 'correcting', detail)
              },
            })
            if (signal.aborted) throw new DOMException('已取消', 'AbortError')
            await pendingCheckpoint
            const complete: StoredMessage = {
              ...base,
              status: 'complete',
              reply: result.reply,
              content: JSON.stringify(result.reply.value),
              usage: result.usage,
              correction: result.correction ?? correction,
            }
            partial = result.reply
            await saveGenerated(complete, snapshot.revision, regen)
            committed = true
            if (result.reply.kind === 'narrative')
              writer.write({ type: 'data-narrative', id: 'reply', data: result.reply.value })
            else writer.write({ type: 'data-forum', id: 'reply', data: result.reply.value })
            const calibration = calibrate(channel, result.usage?.input, estimate.estimated)
            completedChannel = { ...channel, calibration: calibration ?? channel.calibration }
            if (calibration)
              try {
                await db.channels.update(channel.id, { calibration })
              } catch (error) {
                status(writer, 'complete', `回复已保存；用量校正未保存：${friendlyError(error)}`)
              }
            if (
              !contextBudget(completedChannel, persona, kind, [...messages, complete], summary)
                .mustCompress
            )
              completedChannel = undefined
          }
          const storage = await db.persistence.flush()
          status(
            writer,
            'complete',
            storage.phase === 'error'
              ? `回复已保存到浏览器数据库；OPFS 同步失败：${storage.error}`
              : '回复已保存',
          )
          writer.write({
            type: 'finish',
            finishReason: 'stop',
            messageMetadata: { createdAt, kind, status: 'complete' },
          })
          // End the UI stream before optional post-reply LLM compaction, which may be slow.
          if (completedChannel)
            void this.compactAfterReply(
              snapshot.id,
              snapshot.revision + 1,
              completedChannel,
              persona,
              kind,
            ).catch((error) => db.persistence.reportError(error))
        } catch (error) {
          await pendingCheckpoint
          let detail = friendlyError(error)
          const cancelled = signal.aborted
          if (!committed) {
            const recovery: StoredMessage = {
              ...base,
              status: cancelled ? 'cancelled' : 'failed',
              partial,
              correction,
              error: detail,
              content: partial ? JSON.stringify(partial.value) : '',
              rawContent,
            }
            // Regeneration failures append recovery data; the old branch is still intact.
            try {
              await saveRecovery(recovery)
            } catch (storageError) {
              detail += `；恢复记录保存失败：${friendlyError(storageError)}`
            }
          }
          await db.persistence.flush()
          const outcome = committed ? 'complete' : cancelled ? 'cancelled' : 'failed'
          status(writer, outcome, committed ? `回复已保存；${detail}` : detail)
          writer.write({
            type: 'finish',
            finishReason: committed ? 'stop' : 'error',
            messageMetadata: {
              createdAt,
              kind,
              status: outcome,
              error: committed ? undefined : detail,
            },
          })
          if (!cancelled && !committed) writer.write({ type: 'error', errorText: detail })
        }
      },
      onError: friendlyError,
    })
  }
  async reconnectToStream() {
    return null
  }
}
