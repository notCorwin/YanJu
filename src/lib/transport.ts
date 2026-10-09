import { prepareHistoryEdit, messageSnapshot } from './game-history'
import { registerGameOperation } from './game-operations'
import { interceptImage, isRoleIntercepted } from '@/content/intercept'
import {
  createUIMessageStream,
  type ChatTransport,
  type DeepPartial,
  type UIMessageStreamWriter,
} from 'ai'
import { calibrate, compactContext, contextBudget } from './context'
import { acquireArchiveOperation, withArchiveOperation } from './operations'
import { buildInstructions, modelMessages } from './prompts'
import { channelIsReady, friendlyError, generateReply, summarize } from './provider'
import { errorDiagnostics } from './request-trace'
import type { ForumReply, NarrativeReply, RequestKind } from './schemas'
import { sanitizePartial } from './schemas'
import { appendMessage, archiveMessages, commitSummary, db, refreshStory, revise } from './storage'
import { applyMessage, displayCountdown, rebuildStory, storyContext } from './story'
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
      diagnostics: message.diagnostics,
    },
  }
}

export async function persistCancelledMessage(
  archiveId: string,
  message: ChatMessage | undefined,
  navigationEpoch?: number,
) {
  await db.transaction(
    'rw',
    [...db.gameTables, db.archives, db.messages, db.storyStates, db.storyEvents],
    async () => {
      const archive = await db.archives.get(archiveId)
      if (
        !archive ||
        (navigationEpoch !== undefined && (archive.navigationEpoch ?? 0) !== navigationEpoch)
      )
        return
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
      const updated = revise(archive)
      await db.archives.put(updated)
      await refreshStory(db, updated)
    },
  )
}

async function saveGenerated(
  message: StoredMessage,
  revision: number,
  regenerateFromId?: string,
  expectedNodeId?: string,
  expectedOperationOwner?: string,
) {
  if (!regenerateFromId)
    return appendMessage(message, revision, expectedNodeId, expectedOperationOwner)
  await db.transaction('rw', [...db.gameTables, db.operations], async () => {
    if (
      expectedOperationOwner &&
      (await db.operations.get(message.archiveId))?.owner !== expectedOperationOwner
    )
      throw new Error('会话操作已失效，重说结果未写入。')
    const archive = await db.archives.get(message.archiveId)
    if (!archive || archive.revision !== revision)
      throw new Error('存档已变更，重说结果未覆盖原记录。')
    if (expectedNodeId && (await db.sessions.get(message.archiveId))?.nodeId !== expectedNodeId)
      throw new Error('剧情起点已改变，重说结果未写入。')
    const all = await archiveMessages(archive.id)
    const start = all.findIndex((m) => m.id === regenerateFromId)
    if (start < 0) throw new Error('找不到重说的消息')
    message.sequence = all[start].sequence
    const restored = await prepareHistoryEdit(archive, regenerateFromId!)
    await db.messages.bulkDelete(all.slice(start).map((m) => m.id))
    await db.messages.put(message)
    const next = revise(restored, true)
    next.lastUsage = message.usage
    await db.archives.put(next)
    await refreshStory(db, next)
  })
}

async function saveRecovery(message: StoredMessage, navigationEpoch = 0, operationOwner?: string) {
  await db.transaction('rw', [...db.gameTables, db.operations], async () => {
    if (operationOwner && (await db.operations.get(message.archiveId))?.owner !== operationOwner)
      throw new Error('会话操作已失效，旧回复未写入。')
    const archive = await db.archives.get(message.archiveId)
    if (!archive || (archive.navigationEpoch ?? 0) !== navigationEpoch)
      throw new Error('当前路线已改变，旧回复未写入。')
    const all = await archiveMessages(archive.id)
    const previous = all.find((m) => m.id === message.id)
    if (previous?.status === 'complete') return
    await db.messages.put({
      ...message,
      sequence: previous?.sequence ?? (all.at(-1)?.sequence ?? -1) + 1,
    })
    const updated = revise(archive)
    await db.archives.put(updated)
    await refreshStory(db, updated)
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
  persist = true,
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
      summarize: (input, s) => summarize(channel, input, s, undefined, archive.id),
      commit: (s) => (persist ? commitSummary(archive.id, archive.revision, s) : Promise.resolve()),
    })
  } catch (error) {
    if (persist && signal.reason !== supersededCompaction)
      await db.transaction('rw', [...db.gameTables, db.archives], async () => {
        const current = await db.archives.get(archive.id)
        if (current?.revision === archive.revision)
          await db.archives.update(archive.id, { compactionError: friendlyError(error) })
      })
    throw error
  }
}

export class BrowserChatTransport implements ChatTransport<ChatMessage> {
  private compaction?: AbortController
  private settled = Promise.resolve()
  waitForIdle() {
    return this.settled
  }

  private async compactAfterReply(
    archiveId: string,
    revision: number,
    channel: Channel,
    persona: Persona | undefined,
    kind: RequestKind,
  ) {
    const controller = new AbortController()
    this.compaction = controller
    let finish!: () => void
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const unregister = registerGameOperation(archiveId, async () => {
      controller.abort(supersededCompaction)
      await finished
    })
    try {
      await withArchiveOperation(archiveId, async () => {
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
      })
    } catch {
      // Compaction errors live on the archive; the completed reply stays complete and usable.
    } finally {
      try {
        if (this.compaction === controller) this.compaction = undefined
        await db.persistence.flush()
      } finally {
        unregister()
        finish()
      }
    }
  }

  async sendMessages(options: Parameters<ChatTransport<ChatMessage>['sendMessages']>[0]) {
    const body = options.body as Record<string, unknown> | undefined
    if (typeof body?.operationOwner === 'string') {
      if ((await db.operations.get(options.chatId))?.owner !== body.operationOwner)
        throw new Error('会话操作已失效，请重新发送。')
      return this.sendWithOperation(options, undefined, body.operationOwner)
    }
    const operation = await acquireArchiveOperation(options.chatId)
    try {
      return await this.sendWithOperation(options, operation.release, operation.owner)
    } catch (error) {
      await operation.release()
      throw error
    }
  }
  private async sendWithOperation(
    options: Parameters<ChatTransport<ChatMessage>['sendMessages']>[0],
    release?: () => Promise<void>,
    operationOwner?: string,
  ) {
    const body = options.body as Record<string, unknown> | undefined
    this.compaction?.abort(supersededCompaction)
    const settings = await db.settings.get('app')
    let archive = await db.archives.get(options.chatId)
    const channelId =
      typeof body?.channelId === 'string' ? body.channelId : settings?.activeChannelId
    const personaId =
      typeof body?.personaId === 'string' ? body.personaId : settings?.activePersonaId
    const channel = channelId ? await db.channels.get(channelId) : undefined
    if (!archive) throw new Error('存档不存在，请创建或选择存档。')
    if (!channel || !channelIsReady(channel))
      throw new Error('请先配置渠道并通过JSON 校验与浏览器连接测试。')
    const all = await archiveMessages(archive.id)
    const regen = typeof body?.regenerateFromId === 'string' ? body.regenerateFromId : undefined
    const regenIndex = regen ? all.findIndex((m) => m.id === regen) : -1
    if (
      regenIndex >= 0 &&
      archive.summary &&
      regenIndex <= all.findIndex((m) => m.id === archive!.summary?.coveredThroughId)
    ) {
      archive = { ...archive, summary: undefined }
    }
    if (
      regenIndex >= 0 &&
      all[regenIndex].status === 'complete' &&
      (await db.sessions.get(archive.id))
    ) {
      const historical = await messageSnapshot(archive.id, regen!, db)
      archive = {
        ...historical.archive,
        revision: archive.revision,
        navigationEpoch: archive.navigationEpoch,
        summary: undefined,
      }
    }
    const persona = archive.content
      ? archive.persona
      : personaId
        ? await db.personas.get(personaId)
        : undefined
    const snapshot = archive
    const startingNodeId = (await db.sessions.get(snapshot.id))?.nodeId
    const messages = regenIndex >= 0 ? all.slice(0, regenIndex) : all
    const lastUser = messages.findLast((m) => m.role === 'user' && !m.stale)
    if (!lastUser) throw new Error('没有可回复的用户消息。')
    const beforeStory = rebuildStory(snapshot, messages).story
    if (!lastUser.requestContext) {
      lastUser.requestContext = JSON.stringify(storyContext(beforeStory))
      await db.transaction('rw', [...db.gameTables, db.archives, db.messages], async () => {
        if ((await db.archives.get(snapshot.id))?.revision !== snapshot.revision)
          throw new Error('冻结请求时存档已变更，请重试。')
        await db.messages.update(lastUser.id, { requestContext: lastUser.requestContext })
      })
    }
    const kind: RequestKind =
      body?.kind === 'forum' || lastUser.kind === 'forum' ? 'forum' : 'narrative'
    const navigationController = new AbortController()
    const signal = AbortSignal.any([
      navigationController.signal,
      ...(options.abortSignal ? [options.abortSignal] : []),
      ...(body?.operationSignal instanceof AbortSignal ? [body.operationSignal] : []),
    ])
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
    let settle!: () => void
    this.settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const unregister = registerGameOperation(snapshot.id, async () => {
      navigationController.abort()
      await this.settled
      await body?.operationFinished
    })
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
            await saveGenerated(notice, snapshot.revision, regen, startingNodeId, operationOwner)
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
              false,
              !regen,
            )
            const estimate = contextBudget(
              channel,
              persona,
              kind,
              messages,
              summary,
              snapshot.content,
            )
            if (estimate.mustCompress)
              throw new Error('压缩后仍没有足够上下文，请选择上下文容量更大的模型或缩短输入。')
            status(writer, 'generating', '正在生成 JSON 回复…')
            const result = await generateReply({
              archiveId: snapshot.id,
              ownerId: base.id,
              channel,
              kind,
              instructions: buildInstructions(persona, kind, snapshot.content),
              messages: modelMessages(messages, summary),
              signal,
              estimatedInput: estimate.estimated,
              validate: (reply) =>
                applyMessage(structuredClone(beforeStory), { ...base, status: 'complete', reply }),
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
                      db.transaction('rw', [...db.gameTables, db.operations], async () => {
                        const current = await db.archives.get(snapshot.id)
                        if (
                          current?.revision === snapshot.revision &&
                          (await db.operations.get(snapshot.id))?.owner === operationOwner &&
                          (!startingNodeId ||
                            (await db.sessions.get(snapshot.id))?.nodeId === startingNodeId)
                        )
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
            if (result.reply.kind === 'narrative') {
              const projected = structuredClone(beforeStory)
              applyMessage(projected, { ...base, status: 'complete', reply: result.reply })
              result.reply.value.diary.countdownDays = displayCountdown(projected)
            } else {
              const lines = lastUser.content.split('\n')
              const title =
                lines[0] === '$发送帖子' && /^标题[：:]/.test(lines[1] ?? '') ? lines[1] : undefined
              result.reply.value.post.author = persona?.name ?? snapshot.userName ?? '沈辞玉'
              if (title) result.reply.value.post.title = title.replace(/^标题[：:]\s*/, '')
              result.reply.value.post.content = title
                ? lines.slice(2).join('\n')
                : lines[0] === '$发送帖子'
                  ? lines.slice(1).join('\n')
                  : lastUser.content
            }
            await pendingCheckpoint
            const complete: StoredMessage = {
              ...base,
              status: 'complete',
              reply: result.reply,
              content: JSON.stringify(result.reply.value),
              usage: result.usage,
              diagnostics: result.diagnostics,
              correction: result.correction ?? correction,
            }
            partial = result.reply
            await saveGenerated(complete, snapshot.revision, regen, startingNodeId, operationOwner)
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
              !contextBudget(
                completedChannel,
                persona,
                kind,
                [...messages, complete],
                summary,
                snapshot.content,
              ).mustCompress
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
            messageMetadata: {
              createdAt,
              kind,
              status: 'complete',
              diagnostics: (await db.messages.get(messageId))?.diagnostics,
            },
          })
        } catch (error) {
          await pendingCheckpoint.catch(() => undefined)
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
              diagnostics: errorDiagnostics(error),
            }
            // Regeneration failures append recovery data; the old branch is still intact.
            try {
              await saveRecovery(recovery, snapshot.navigationEpoch, operationOwner)
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
              diagnostics: errorDiagnostics(error),
            },
          })
          if (!cancelled && !committed) writer.write({ type: 'error', errorText: detail })
        } finally {
          try {
            await release?.()
          } finally {
            unregister()
            settle()
          }
          if (completedChannel)
            setTimeout(() => {
              void this.compactAfterReply(
                snapshot.id,
                snapshot.revision + 1,
                completedChannel!,
                persona,
                kind,
              ).catch((error) => db.persistence.reportError(error))
            }, 0)
        }
      },
      onError: friendlyError,
    })
  }
  async reconnectToStream() {
    return null
  }
}
