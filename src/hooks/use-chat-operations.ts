import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { useChat } from '@ai-sdk/react'
import { appendMessage, archiveMessages, db, recentArchiveMessages } from '@/lib/db'
import { compressArchive, persistCancelledMessage, toChatMessage } from '@/lib/transport'
import { withArchiveOperation } from '@/lib/operations'
import { channelIsReady, friendlyError } from '@/lib/provider'
import type { Archive, Channel, ChatMessage, Persona, StoredMessage } from '@/lib/types'
import type { RequestKind } from '@/lib/schemas'
import type { Notify } from '@/components/managers'

type Chat = ReturnType<typeof useChat<ChatMessage>>
export function useChatOperations(options: {
  archive: Archive
  channel?: Channel
  persona?: Persona
  mode: RequestKind
  limit: number
  chat: Chat
  notify: Notify
  onBusy: (value: boolean) => void
  settle: () => Promise<void>
}) {
  const [input, setInput] = useState(options.archive.draft)
  const [phase, setPhase] = useState<'idle' | 'sending' | 'retrying' | 'compressing'>('idle')
  const latest = useRef(options)
  useLayoutEffect(() => {
    latest.current = options
  }, [options])
  const inputValue = useRef(input)
  const localLock = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const operation = useRef<{ controller: AbortController; phase: string } | null>(null)
  const busy =
    phase !== 'idle' || options.chat.status === 'streaming' || options.chat.status === 'submitted'
  const stop = options.chat.stop
  const onBusy = options.onBusy
  useEffect(() => {
    onBusy(busy)
  }, [busy, onBusy])
  useEffect(
    () => () => {
      void stop()
      operation.current?.controller.abort()
      onBusy(false)
    },
    [stop, onBusy],
  )

  const draft = useCallback((text: string) => {
    inputValue.current = text
    setInput(text)
    const { archive, notify } = latest.current
    void db.archives
      .update(archive.id, { draft: text })
      .catch((error) => notify(friendlyError(error), true))
  }, [])
  const refresh = useCallback(async () => {
    const { archive, limit, chat } = latest.current
    chat.setMessages((await recentArchiveMessages(archive.id, limit)).messages.map(toChatMessage))
  }, [])
  const run = useCallback(
    async (
      next: Exclude<typeof phase, 'idle'>,
      action: (owner: string, signal: AbortSignal) => Promise<void>,
    ) => {
      if (localLock.current) return
      const { archive, channel, chat, notify } = latest.current
      if (!channel || !channelIsReady(channel)) {
        notify('请先配置渠道并通过严格结构化与浏览器连接测试。', true)
        return
      }
      localLock.current = true
      const controller = new AbortController()
      operation.current = { controller, phase: next }
      setPhase(next)
      chat.clearError()
      try {
        await withArchiveOperation(archive.id, async (lease) => {
          if (controller.signal.aborted) throw new DOMException('已取消', 'AbortError')
          try {
            await action(lease.owner, controller.signal)
          } finally {
            await latest.current.settle()
          }
        })
      } catch (error) {
        notify(friendlyError(error), true)
      } finally {
        try {
          await refresh()
        } catch (error) {
          notify(friendlyError(error), true)
        }
        localLock.current = false
        operation.current = null
        setPhase('idle')
      }
    },
    [refresh],
  )
  const send = useCallback(
    async (text = inputValue.current, explicitKind?: RequestKind) => {
      if (!text.trim()) return
      await run('sending', async (operationOwner, operationSignal) => {
        const { archive, channel, persona, mode, chat } = latest.current
        const kind =
          explicitKind ?? (/^(\$发送帖子|新帖[：:]|回复.+[：:])/.test(text) ? 'forum' : mode)
        const user: StoredMessage = {
          id: crypto.randomUUID(),
          archiveId: archive.id,
          role: 'user',
          content: text.trim(),
          createdAt: Date.now(),
          sequence: 0,
          kind,
          status: 'complete',
        }
        await appendMessage(user)
        draft('')
        await chat.sendMessage(
          {
            id: user.id,
            role: 'user',
            parts: [{ type: 'text', text: user.content }],
            metadata: { createdAt: user.createdAt, kind, status: 'complete' },
          },
          {
            body: {
              kind,
              operationOwner,
              operationSignal,
              channelId: channel!.id,
              personaId: persona?.id ?? '',
            },
          },
        )
      })
    },
    [draft, run],
  )
  const retry = useCallback(
    (id: string) =>
      run('retrying', async (operationOwner, operationSignal) => {
        const { archive, channel, persona, chat } = latest.current
        const all = await archiveMessages(archive.id)
        const target = all.find((message) => message.id === id)
        if (!target) throw new Error('消息不存在。')
        await chat.regenerate({
          messageId: id,
          body: {
            regenerateFromId: id,
            kind: target.kind === 'forum' ? 'forum' : 'narrative',
            operationOwner,
            operationSignal,
            channelId: channel!.id,
            personaId: persona?.id ?? '',
          },
        })
      }),
    [run],
  )
  const compress = useCallback(
    () =>
      run('compressing', async (_owner, signal) => {
        const { archive, channel, persona, mode, notify } = latest.current
        const current = await db.archives.get(archive.id)
        if (!current) throw new Error('存档不存在。')
        await compressArchive(
          current,
          channel!,
          persona,
          await archiveMessages(archive.id),
          signal,
          mode,
          (detail) => notify(detail),
          true,
        )
        await db.persistence.flush()
        notify('上下文压缩完成，原文保留。')
      }),
    [run],
  )
  const stopGeneration = useCallback(async () => {
    const active = operation.current
    active?.controller.abort()
    const { archive, chat, notify } = latest.current
    try {
      await chat.stop()
      await latest.current.settle()
      if (active?.phase !== 'compressing')
        await persistCancelledMessage(archive.id, chat.messages.at(-1))
      await db.persistence.flush()
      await refresh()
    } catch (error) {
      notify(friendlyError(error), true)
    }
  }, [refresh])
  return {
    input,
    draft,
    inputRef,
    send,
    retry,
    compress,
    stopGeneration,
    busy,
    compressing: phase === 'compressing',
    localLock,
  }
}
