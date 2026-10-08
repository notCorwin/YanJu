import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  archiveMessages,
  db,
  appendMessage,
  createArchiveData,
  editMessage,
  revise,
  refreshStory,
} from '@/lib/db'
import {
  BrowserChatTransport,
  compressArchive,
  persistCancelledMessage,
  toChatMessage,
} from '@/lib/transport'
import { executeAuxiliary } from '@/lib/workflows'
import { contextBudget } from '@/lib/context'
import { channelIsReady, friendlyError } from '@/lib/provider'
import type { Archive, Channel, ChatMessage, Persona, StoredMessage } from '@/lib/types'
import type { RequestKind } from '@/lib/schemas'
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from './ui/message-scroller'
import { Message, MessageContent, MessageHeader, MessageFooter } from './ui/message'
import { Bubble, BubbleContent } from './ui/bubble'
import { InputGroup, InputGroupTextarea, InputGroupAddon, InputGroupButton } from './ui/input-group'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Progress } from './ui/progress'
import { Select, SelectContent, SelectTrigger, SelectValue, SelectItem } from './ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog'
import { Textarea } from './ui/textarea'
import { Field, FieldLabel } from './ui/field'
import { NarrativeView, ForumView } from './replies'
import { ConfirmDialog, IconButton, Prose } from './shared'
import type { Notify } from './managers'
import {
  Send,
  Square,
  Copy,
  Pencil,
  RotateCcw,
  LoaderCircle,
  Trash2,
  ArrowDownToLine,
  BookOpen,
} from 'lucide-react'

export interface ExternalChatRequest {
  id: string
  text: string
  kind: RequestKind
  expectedRevision?: number
  complete: (committed: boolean) => void
}

export function ChatSession(props: {
  archive: Archive
  channel?: Channel
  persona?: Persona
  notify: Notify
  onBusy: (value: boolean) => void
  onWorld: () => void
  insert: string
  onInserted: () => void
  externalRequest: ExternalChatRequest | null
  onExternalHandled: () => void
  externalMode: RequestKind | null
  onModeHandled: () => void
  sourceMessage?: string
  sourceBlock?: string
  onSourceHandled: (messageId: string, blockId?: string) => void
  disabled: boolean
  onStudio: () => void
}) {
  const stored = useLiveQuery(() => archiveMessages(props.archive.id), [props.archive.id])
  if (!stored)
    return (
      <p role="status" className="p-6 text-muted-foreground">
        正在读取存档…
      </p>
    )
  return <ChatRunner {...props} stored={stored} />
}
function ChatRunner({
  archive,
  channel,
  persona,
  notify,
  onBusy,
  onWorld,
  stored,
  insert,
  onInserted,
  externalRequest,
  onExternalHandled,
  externalMode,
  onModeHandled,
  sourceMessage,
  sourceBlock,
  onSourceHandled,
  disabled,
  onStudio,
}: {
  archive: Archive
  channel?: Channel
  persona?: Persona
  notify: Notify
  onBusy: (value: boolean) => void
  onWorld: () => void
  stored: StoredMessage[]
  insert: string
  onInserted: () => void
  externalRequest: ExternalChatRequest | null
  onExternalHandled: () => void
  externalMode: RequestKind | null
  onModeHandled: () => void
  sourceMessage?: string
  sourceBlock?: string
  onSourceHandled: (messageId: string, blockId?: string) => void
  disabled: boolean
  onStudio: () => void
}) {
  const transport = useMemo(() => new BrowserChatTransport(), [])
  const finishedMessage = useRef<string | null>(null)
  const { messages, sendMessage, regenerate, setMessages, stop, status, error, clearError } =
    useChat<ChatMessage>({
      id: archive.id,
      transport,
      messages: stored.map(toChatMessage),
      generateId: () => crypto.randomUUID(),
      onError: (e) => notify(friendlyError(e), true),
      onFinish: ({ message }) => {
        finishedMessage.current = message.id
      },
    })
  const [input, setInput] = useState(archive.draft)
  const [mode, setMode] = useState<RequestKind>('narrative')
  const [editing, setEditing] = useState<StoredMessage | null>(null)
  const [editText, setEditText] = useState('')
  const [regenId, setRegenId] = useState('')
  const [clear, setClear] = useState(false)
  const [compressing, setCompressing] = useState(false)
  const [forumRunning, setForumRunning] = useState(false)
  const [forumPartial, setForumPartial] = useState('')
  const story = useLiveQuery(() => db.storyStates.get(archive.id), [archive.id])
  const lock = useRef(false)
  const composing = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const controller = useRef<AbortController | null>(null)
  const chatBusy = status === 'streaming' || status === 'submitted' || compressing || forumRunning
  const busy = chatBusy || disabled

  useEffect(() => {
    onBusy(chatBusy)
  }, [chatBusy, onBusy])
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
      setInput((v) => (v ? `${v}\n${insert}` : insert))
      onInserted()
      inputRef.current?.focus()
    }
  }, [insert, onInserted])
  const draft = (text: string) => {
    setInput(text)
    void db.archives.update(archive.id, { draft: text })
  }

  const send = async (
    text = input,
    explicitKind?: RequestKind,
    expectedRevision?: number,
    fromStudio = false,
  ) => {
    if (!text.trim() || chatBusy || (!fromStudio && disabled) || lock.current) return false
    if (!channel || !channelIsReady(channel)) {
      notify('请先配置渠道，并通过严格结构化和浏览器连接测试。', true)
      return false
    }
    const kind = explicitKind ?? (/^(\$发送帖子|新帖[：:]|回复.+[：:])/.test(text) ? 'forum' : mode)
    lock.current = true
    onBusy(true)
    clearError()
    finishedMessage.current = null
    try {
      const current = await archiveMessages(archive.id)
      const user: StoredMessage = {
        id: crypto.randomUUID(),
        archiveId: archive.id,
        role: 'user',
        content: text,
        userName: persona?.name ?? archive.userName ?? '沈辞玉',
        createdAt: Date.now(),
        sequence: (current.at(-1)?.sequence ?? -1) + 1,
        kind,
        status: 'complete',
      }
      await appendMessage(user, expectedRevision)
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
      const complete = finishedMessage.current
        ? await db.messages.get(finishedMessage.current)
        : undefined
      return complete?.status === 'complete' && !complete.stale && complete.reply?.kind === kind
    } catch (e) {
      notify(friendlyError(e), true)
      return false
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
  const external = useEffectEvent(async (request: ExternalChatRequest) => {
    onExternalHandled()
    let committed = false
    try {
      committed = await send(request.text, request.kind, request.expectedRevision, true)
    } finally {
      request.complete(committed)
    }
  })
  useEffect(() => {
    if (externalRequest && !chatBusy && !lock.current) void external(externalRequest)
  }, [externalRequest, chatBusy])
  useEffect(() => {
    if (externalMode) {
      setMode(externalMode)
      onModeHandled()
    }
  }, [externalMode, onModeHandled])
  useEffect(() => {
    if (!sourceMessage || busy) return
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(
        sourceBlock ? `source-block-${sourceMessage}-${sourceBlock}` : `message-${sourceMessage}`,
      )
      if (!element) {
        notify('这条消息已被重说替换，可在工作台的请求记录中查看原结果。', true)
      } else {
        element.scrollIntoView({ block: 'center' })
        element.focus({ preventScroll: true })
      }
      onSourceHandled(sourceMessage, sourceBlock)
    })
    return () => cancelAnimationFrame(frame)
  }, [sourceMessage, sourceBlock, busy, notify, onSourceHandled])
  const replyToForum = async (id: string, text: string) => {
    if (busy || lock.current) return
    lock.current = true
    setForumRunning(true)
    setForumPartial('')
    controller.current = new AbortController()
    try {
      const task = await executeAuxiliary(archive.id, 'forumReply', text, id, {
        signal: controller.current.signal,
      })
      if (task.status !== 'complete') notify(task.error ?? '论坛回复未完成，可在工作台重试。', true)
    } catch (error) {
      notify(friendlyError(error), true)
    } finally {
      lock.current = false
      setForumRunning(false)
      controller.current = null
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
    if (forumRunning) {
      controller.current?.abort()
      return
    }
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
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {archive.compactionError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 border-b-(length:--border-width) p-3 text-sm text-destructive"
        >
          <span className="min-w-0 flex-1 wrap-break-word">
            压缩未完成：{archive.compactionError}
          </span>
          <Button disabled={busy} variant="outline" onClick={() => void compress()}>
            重试压缩
          </Button>
        </div>
      )}
      <MessageScrollerProvider defaultScrollPosition="end">
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto reading-width px-4 py-8 sm:px-6">
              {messages.map((message, i) => (
                <MessageScrollerItem key={message.id} scrollAnchor={message.role === 'user'}>
                  <article
                    id={`message-${message.id}`}
                    tabIndex={-1}
                    aria-label={message.role === 'user' ? '你的消息' : '宴雎的回复'}
                  >
                    <Message align={message.role === 'user' ? 'end' : 'start'}>
                      <MessageContent>
                        <MessageHeader>
                          <span className="flex items-center gap-2">
                            {message.role === 'user'
                              ? (stored.find((m) => m.id === message.id)?.userName ??
                                persona?.name ??
                                '你')
                              : '宴雎'}
                            {stored.find((m) => m.id === message.id)?.stale && (
                              <Badge variant="outline">已失效 · 历史记录</Badge>
                            )}
                            {message.metadata?.createdAt && (
                              <time dateTime={new Date(message.metadata.createdAt).toISOString()}>
                                {new Date(message.metadata.createdAt).toLocaleTimeString('zh-CN', {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </time>
                            )}
                            {message.metadata?.status && message.metadata.status !== 'complete' && (
                              <Badge variant="outline">
                                {message.metadata.status === 'partial'
                                  ? '生成中'
                                  : message.metadata.status === 'cancelled'
                                    ? '已停止'
                                    : '待恢复'}
                              </Badge>
                            )}
                          </span>
                        </MessageHeader>
                        {message.role === 'user' ? (
                          <Bubble variant="secondary" align="end">
                            <BubbleContent>
                              {message.parts.map((p, j) =>
                                p.type === 'text' ? <Prose key={j} text={p.text} /> : null,
                              )}
                            </BubbleContent>
                          </Bubble>
                        ) : (
                          <Bubble variant="ghost">
                            <BubbleContent className="w-full">
                              {message.parts.map((p, j) => {
                                if (p.type === 'data-narrative')
                                  return (
                                    <NarrativeView key={j} reply={p.data} messageId={message.id} />
                                  )
                                if (p.type === 'data-forum')
                                  return (
                                    <ForumView
                                      key={j}
                                      reply={
                                        story?.forums.find(
                                          (f) => f.source.messageId === message.id,
                                        ) ?? p.data
                                      }
                                      disabled={
                                        busy || stored.find((m) => m.id === message.id)?.stale
                                      }
                                      onReply={(id, text) => void replyToForum(id, text)}
                                      onSend={(text) => void send(text, 'forum')}
                                    />
                                  )
                                if (p.type === 'data-notice')
                                  return (
                                    <img
                                      key={j}
                                      src={p.data}
                                      alt="角色设定提示"
                                      className="max-w-full rounded-lg"
                                      loading="lazy"
                                    />
                                  )
                                if (p.type === 'text') return <Prose key={j} text={p.text} />
                                return null
                              })}
                            </BubbleContent>
                          </Bubble>
                        )}
                        {message.metadata?.error && (
                          <p role="alert" className="text-sm text-destructive">
                            {message.metadata.error}
                          </p>
                        )}
                        <MessageFooter>
                          <div className="flex flex-wrap gap-1">
                            <IconButton label="复制消息" onClick={() => copy(message)}>
                              <Copy />
                            </IconButton>
                            <IconButton
                              label="编辑消息"
                              disabled={busy}
                              onClick={() => {
                                const m = stored.find((m) => m.id === message.id)
                                if (m) {
                                  setEditing(m)
                                  setEditText(
                                    m.reply
                                      ? JSON.stringify(m.reply.value, null, 2)
                                      : m.interaction
                                        ? JSON.stringify(m.interaction, null, 2)
                                        : m.effects
                                          ? JSON.stringify(
                                              { content: m.content, effects: m.effects },
                                              null,
                                              2,
                                            )
                                          : m.rawContent || m.content,
                                  )
                                }
                              }}
                            >
                              <Pencil />
                            </IconButton>
                            {message.role === 'assistant' &&
                              i > 0 &&
                              ['narrative', 'forum'].includes(message.metadata?.kind ?? '') && (
                                <IconButton
                                  label={
                                    message.metadata?.status === 'failed' ||
                                    message.metadata?.status === 'cancelled'
                                      ? '重试回复'
                                      : '重新生成'
                                  }
                                  disabled={busy}
                                  onClick={() => {
                                    if (i < messages.length - 1) setRegenId(message.id)
                                    else void retry(message.id)
                                  }}
                                >
                                  <RotateCcw />
                                </IconButton>
                              )}
                          </div>
                        </MessageFooter>
                      </MessageContent>
                    </Message>
                  </article>
                </MessageScrollerItem>
              ))}
              {forumRunning && forumPartial && <Prose text={forumPartial} />}
              {chatBusy && (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-2 text-ui text-primary"
                >
                  <LoaderCircle className="size-4 animate-spin" />
                  {forumRunning
                    ? '正在生成论坛回复…'
                    : compressing
                      ? '正在压缩历史…'
                      : latestStatus?.type === 'data-status'
                        ? latestStatus.data.detail
                        : '准备生成…'}
                </div>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton aria-label="回到最新消息" size="icon" />
        </MessageScroller>
      </MessageScrollerProvider>
      <footer className="surface safe-bottom shrink-0 border-t-(length:--border-width) px-3 pt-3 sm:px-6">
        <div className="mx-auto flex reading-width flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Select value={mode} onValueChange={(v) => setMode(v as RequestKind)} disabled={busy}>
                <SelectTrigger aria-label="聊天模式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="narrative">叙事</SelectItem>
                  <SelectItem value="forum">论坛</SelectItem>
                </SelectContent>
              </Select>
              <IconButton label="打开剧情工作台" onClick={onStudio}>
                <BookOpen />
              </IconButton>
              <IconButton label="世界、指令与音乐" onClick={onWorld}>
                <BookOpen />
              </IconButton>
              <IconButton label="清空当前聊天" disabled={busy} onClick={() => setClear(true)}>
                <Trash2 />
              </IconButton>
            </div>
            {budget && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  上下文约 {Math.round(budget.percent * 100)}% · {budget.estimated.toLocaleString()}{' '}
                  / {channel!.contextWindow.toLocaleString()}
                </span>
                <IconButton label="压缩上下文" disabled={busy} onClick={() => void compress()}>
                  <ArrowDownToLine />
                </IconButton>
              </div>
            )}
          </div>
          {budget && (
            <Progress aria-label="估算上下文占用" value={Math.min(100, budget.percent * 100)} />
          )}
          {archive.lastUsage && (
            <p className="text-xs text-muted-foreground">
              上次实际输入 {archive.lastUsage.input.toLocaleString()} · 输出{' '}
              {archive.lastUsage.output.toLocaleString()} tokens
              {archive.summary && ` · 摘要覆盖 ${archive.summary.coveredCount} 条消息`}
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!composing.current) void send()
            }}
          >
            <InputGroup>
              <InputGroupTextarea
                ref={inputRef}
                aria-label="聊天输入"
                value={input}
                onChange={(e) => draft(e.target.value)}
                onCompositionStart={() => {
                  composing.current = true
                }}
                onCompositionEnd={() => {
                  composing.current = false
                }}
                onKeyDown={(e) => {
                  if (
                    e.key === 'Enter' &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing &&
                    !composing.current &&
                    e.keyCode !== 229
                  ) {
                    e.preventDefault()
                    if (!busy) void send()
                  }
                }}
                rows={2}
                placeholder={mode === 'forum' ? '输入帖子或回复内容…' : '写下你的回应…'}
              />
              <InputGroupAddon align="block-end" className="justify-between">
                <span className="text-xs text-muted-foreground">
                  Enter 发送 · Shift + Enter 换行
                </span>
                {chatBusy ? (
                  <InputGroupButton
                    aria-label="停止生成"
                    onClick={() => void stopGeneration()}
                    variant="secondary"
                    size="sm"
                  >
                    <Square />
                    停止
                  </InputGroupButton>
                ) : (
                  <InputGroupButton
                    type="submit"
                    aria-label="发送消息"
                    variant="default"
                    size="sm"
                    disabled={busy || !input.trim()}
                  >
                    <Send />
                    发送
                  </InputGroupButton>
                )}
              </InputGroupAddon>
            </InputGroup>
          </form>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {friendlyError(error)}
            </p>
          )}
        </div>
      </footer>
      <Dialog open={editing !== null} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:page-width">
          <DialogHeader>
            <DialogTitle>编辑消息</DialogTitle>
            <DialogDescription>
              {editing?.reply || editing?.interaction || editing?.effects
                ? '回复保存为 JSON 内容。修改后会检查结构；已覆盖这条消息的摘要会失效并在需要时重建。'
                : '修改后保留这条消息的时间和所属存档；后续剧情会标记失效并重建状态。'}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="edit-message">消息内容</FieldLabel>
            <Textarea
              id="edit-message"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={12}
            />
          </Field>
          <DialogFooter>
            <Button
              disabled={busy || !editText.trim()}
              onClick={() => {
                if (editing && !busy)
                  void editMessage(editing.id, editText)
                    .then(() => {
                      setEditing(null)
                      notify('消息已更新。')
                    })
                    .catch((e) => notify(friendlyError(e), true))
              }}
            >
              保存修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!regenId}
        onClose={() => setRegenId('')}
        title="从这里重新生成？"
        detail="成功后替换这条回复及其后续内容。生成失败或取消会保留原聊天，并保存收到的部分内容。"
        destructive={false}
        onConfirm={() => retry(regenId)}
      />
      <ConfirmDialog
        open={clear}
        onClose={() => setClear(false)}
        title="清空当前聊天？"
        detail="将删除当前篇章的聊天和摘要，并恢复原开场白。其他存档保留。"
        onConfirm={async () => {
          if (busy || lock.current) return
          const data = createArchiveData()
          await db.transaction(
            'rw',
            [db.messages, db.archives, db.storyStates, db.storyEvents, db.tasks, db.requests],
            async () => {
              await db.messages.where('archiveId').equals(archive.id).delete()
              await db.messages.put({ ...data.opening, archiveId: archive.id })
              await db.tasks.where('archiveId').equals(archive.id).delete()
              await db.requests.where('archiveId').equals(archive.id).delete()
              const updated = { ...revise(archive, true), draft: '' }
              await db.archives.put(updated)
              await refreshStory(db, updated)
            },
          )
          draft('')
          notify('当前聊天已清空。')
        }}
      />
    </div>
  )
}
