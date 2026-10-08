import { contextBudget } from '@/lib/context'
import { channelIsReady, friendlyError } from '@/lib/provider'
import type { RequestKind } from '@/lib/schemas'
import {
  appendMessage,
  archiveMessages,
  db,
  editMessage,
  resetArchive,
  revise,
} from '@/lib/storage'
import {
  BrowserChatTransport,
  compressArchive,
  persistCancelledMessage,
  toChatMessage,
} from '@/lib/transport'
import type { ChatMessage, StoredMessage } from '@/lib/types'
import { useChat } from '@ai-sdk/react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { ChatRunnerProps } from './types'

export function useChatSession({
  archive,
  channel,
  persona,
  notify,
  onBusy,
  stored,
  insert,
  onInserted,
}: ChatRunnerProps) {
  const transport = useMemo(() => new BrowserChatTransport(), [])
  const { messages, sendMessage, regenerate, setMessages, stop, status, error, clearError } =
    useChat<ChatMessage>({
      id: archive.id,
      transport,
      messages: stored.map(toChatMessage),
      generateId: () => crypto.randomUUID(),
      onError: (e) => notify(friendlyError(e), true),
    })
  const [input, setInput] = useState(archive.draft)
  const [mode, setMode] = useState<RequestKind>('narrative')
  const [editing, setEditing] = useState<StoredMessage | null>(null)
  const [editText, setEditText] = useState('')
  const [regenId, setRegenId] = useState('')
  const [clear, setClear] = useState(false)
  const [compressing, setCompressing] = useState(false)
  const lock = useRef(false)
  const composingRef = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const controller = useRef<AbortController | null>(null)
  const busy = status === 'streaming' || status === 'submitted' || compressing

  useEffect(() => {
    onBusy(busy)
  }, [busy, onBusy])
  useEffect(
    () => () => {
      void stop()
      controller.current?.abort()
      onBusy(false)
    },
    [stop, onBusy],
  )
  useEffect(() => {
    if (!lock.current && !busy) setMessages(stored.map(toChatMessage))
  }, [stored, busy, setMessages])
  useEffect(() => {
    if (insert) {
      const value = input ? `${input}\n${insert}` : insert
      setInput(value)
      void db.archives.update(archive.id, { draft: value })
      onInserted()
      inputRef.current?.focus()
    }
  }, [insert, onInserted, input, archive.id])
  const draft = (text: string) => {
    setInput(text)
    void db.archives.update(archive.id, { draft: text })
  }

  const send = async (text = input, explicitKind?: RequestKind) => {
    if (!text.trim() || busy || lock.current) return
    if (!channel || !channelIsReady(channel)) {
      notify('请先配置渠道，并通过严格结构化和浏览器连接测试。', true)
      return
    }
    const kind = explicitKind ?? (/^(\$发送帖子|新帖[：:]|回复.+[：:])/.test(text) ? 'forum' : mode)
    lock.current = true
    onBusy(true)
    clearError()
    try {
      const current = await archiveMessages(archive.id)
      const user: StoredMessage = {
        id: crypto.randomUUID(),
        archiveId: archive.id,
        role: 'user',
        content: text.trim(),
        createdAt: Date.now(),
        sequence: (current.at(-1)?.sequence ?? -1) + 1,
        kind,
        status: 'complete',
      }
      await appendMessage(user)
      draft('')
      await sendMessage(
        {
          id: user.id,
          role: 'user',
          parts: [{ type: 'text', text: user.content }],
          metadata: { createdAt: user.createdAt, kind, status: 'complete' },
        },
        { body: { kind } },
      )
    } catch (e) {
      notify(friendlyError(e), true)
    } finally {
      lock.current = false
      onBusy(false)
      try {
        setMessages((await archiveMessages(archive.id)).map(toChatMessage))
      } catch (e) {
        notify(friendlyError(e), true)
      }
      inputRef.current?.focus()
    }
  }
  const retry = async (id: string) => {
    if (busy || lock.current) return
    if (!channel || !channelIsReady(channel)) {
      notify('请先通过渠道测试。', true)
      return
    }
    lock.current = true
    onBusy(true)
    clearError()
    try {
      const current = await db.archives.get(archive.id)
      const all = await archiveMessages(archive.id)
      const target = all.findIndex((m) => m.id === id)
      if (
        current?.summary &&
        target <= all.findIndex((m) => m.id === current.summary?.coveredThroughId)
      )
        await db.archives.put(revise(current, true))
      await regenerate({
        messageId: id,
        body: { regenerateFromId: id, kind: all[target]?.kind === 'forum' ? 'forum' : 'narrative' },
      })
    } catch (e) {
      notify(friendlyError(e), true)
    } finally {
      lock.current = false
      onBusy(false)
      try {
        setMessages((await archiveMessages(archive.id)).map(toChatMessage))
      } catch (e) {
        notify(friendlyError(e), true)
      }
    }
  }
  const compress = async () => {
    if (busy || !channel || !channelIsReady(channel)) {
      notify('请先通过渠道测试。', true)
      return
    }
    setCompressing(true)
    controller.current = new AbortController()
    try {
      const current = await db.archives.get(archive.id)
      if (current)
        await compressArchive(
          current,
          channel,
          persona,
          await archiveMessages(archive.id),
          controller.current.signal,
          mode,
          (d) => notify(d),
          true,
        )
      notify('上下文压缩完成，原文保留。')
    } catch (e) {
      notify(friendlyError(e), true)
    } finally {
      setCompressing(false)
    }
  }
  const stopGeneration = async () => {
    controller.current?.abort()
    try {
      await stop()
      if (!compressing) await persistCancelledMessage(archive.id, messages.at(-1))
      await db.persistence.flush()
      setMessages((await archiveMessages(archive.id)).map(toChatMessage))
    } catch (e) {
      notify(friendlyError(e), true)
    } finally {
      onBusy(false)
    }
  }
  const budget = channel
    ? contextBudget(
        channel,
        persona,
        mode,
        stored,
        archive.summary?.revision === archive.revision ? archive.summary : undefined,
      )
    : undefined
  const latestStatus = messages.at(-1)?.parts.find((p) => p.type === 'data-status')
  const copy = (message: ChatMessage) => {
    const source = stored.find((m) => m.id === message.id)
    const text =
      source?.reply?.kind === 'narrative'
        ? source.reply.value.blocks
            .map((b) => b.text + (b.translation ? `\n「${b.translation}」` : ''))
            .join('\n\n')
        : source?.content || JSON.stringify(message.parts)
    void navigator.clipboard.writeText(text).then(
      () => notify('消息已复制。'),
      () => notify('复制失败，请使用浏览器的文本选择功能。', true),
    )
  }
  const startEdit = (id: string) => {
    const message = stored.find((m) => m.id === id)
    if (message) {
      setEditing(message)
      setEditText(
        message.reply
          ? JSON.stringify(message.reply.value, null, 2)
          : message.rawContent || message.content,
      )
    }
  }
  const saveEdit = async () => {
    if (!editing) return
    try {
      await editMessage(editing.id, editText)
      setEditing(null)
      notify('消息已更新。')
    } catch (e) {
      notify(friendlyError(e), true)
    }
  }
  const clearArchive = async () => {
    await resetArchive(archive.id)
    setMessages((await archiveMessages(archive.id)).map(toChatMessage))
    draft('')
    notify('当前聊天已清空。')
  }
  return {
    archive,
    channel,
    persona,
    stored,
    messages,
    input,
    mode,
    setMode,
    editing,
    setEditing,
    editText,
    setEditText,
    regenId,
    setRegenId,
    clear,
    setClear,
    compressing,
    busy,
    composingRef,
    inputRef,
    error,
    latestStatus,
    budget,
    draft,
    send,
    retry,
    compress,
    stopGeneration,
    copy,
    startEdit,
    saveEdit,
    clearArchive,
  }
}

export type ChatSessionState = ReturnType<typeof useChatSession>
