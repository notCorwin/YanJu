import type { ReactNode } from 'react'
import { registerGameOperation } from '@/lib/game-operations'
import { forkGame, navigateGame, nodeForMessage } from '@/lib/game-history'
import { saveDraft } from '@/lib/draft-storage'
import { SaveStatus } from '@/components/save-status'
import { MessageEditor } from '@/components/message-editor'
import { RecoveryBoundary } from '@/components/recovery-boundary'
import { RequestDetails } from '@/components/request-details'
import { ConfirmDialog, IconButton, Prose } from '@/components/shared'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group'
import { Message, MessageContent, MessageFooter, MessageHeader } from '@/components/ui/message'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ForumView } from '@/features/chat/replies/forum-view'
import { NarrativeView } from '@/features/chat/replies/narrative-view'
import type { ExternalChatRequest } from '@/features/chat/types'
import { contextBudget } from '@/lib/context'
import type { Notify } from '@/lib/notify'
import { withArchiveOperation } from '@/lib/operations'
import { channelIsReady, friendlyError } from '@/lib/provider'
import type { RequestKind } from '@/lib/schemas'
import { appendMessage, archiveMessages, db } from '@/lib/storage'
import {
  BrowserChatTransport,
  compressArchive,
  persistCancelledMessage,
  toChatMessage,
} from '@/lib/transport'
import type { Archive, Channel, ChatMessage, Persona, StoredMessage, Summary } from '@/lib/types'
import { executeAuxiliary } from '@/lib/workflows'
import { useChat } from '@ai-sdk/react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  ArrowDownToLine,
  BookOpen,
  Copy,
  FileJson,
  GitBranch,
  Pencil,
  RotateCcw,
  Send,
  Square,
  Trash2,
} from 'lucide-react'
import {
  memo,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

export function ChatRunner({
  archive,
  channel,
  channelControl,
  persona,
  notify,
  onBusy,
  onWorld,
  onChannels,
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
  channelControl: ReactNode
  persona?: Persona
  notify: Notify
  onBusy: (value: boolean) => void
  onWorld: () => void
  onChannels: () => void
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
  const [visibleLimit, setVisibleLimit] = useState(60)
  const transport = useMemo(() => new BrowserChatTransport(), [])
  const finishedMessage = useRef<string | null>(null)
  const { messages, sendMessage, regenerate, setMessages, stop, status, error, clearError } =
    useChat<ChatMessage>({
      id: archive.id,
      transport,
      messages: stored.slice(-visibleLimit).map(toChatMessage),
      generateId: () => crypto.randomUUID(),
      onError: (e) => notify(friendlyError(e), true),
      onFinish: ({ message }) => {
        finishedMessage.current = message.id
      },
    })
  const [input, setInput] = useState(archive.draft)
  const [mode, setMode] = useState<RequestKind>('narrative')
  const [contextOpen, setContextOpen] = useState(false)
  const [editing, setEditing] = useState<StoredMessage | null>(null)
  const [regenId, setRegenId] = useState('')
  const [clear, setClear] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [compressing, setCompressing] = useState(false)
  const [forumRunning, setForumRunning] = useState(false)
  const [forumPartial, setForumPartial] = useState('')
  const story = useLiveQuery(() => db.storyStates.get(archive.id), [archive.id])
  const lock = useRef(false)
  const composing = useRef(false)
  const touchInput = useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia('(pointer: coarse)')
      query.addEventListener('change', notify)
      return () => query.removeEventListener('change', notify)
    },
    () => window.matchMedia('(pointer: coarse)').matches,
  )
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const controller = useRef<AbortController | null>(null)
  const chatBusy =
    status === 'streaming' || status === 'submitted' || preparing || compressing || forumRunning
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
    if (!lock.current && !busy) setMessages(stored.slice(-visibleLimit).map(toChatMessage))
  }, [stored, busy, setMessages, visibleLimit])
  const insertDraft = useEffectEvent(async (text: string) => {
    const value = input ? `${input}\n${text}` : text
    setInput(value)
    try {
      await saveDraft(archive.id, value, archive.navigationEpoch ?? 0)
    } catch (error) {
      notify(friendlyError(error), true)
    }
    onInserted()
    inputRef.current?.focus({ preventScroll: true })
  })
  useEffect(() => {
    if (insert) void insertDraft(insert)
  }, [insert])
  const draft = (text: string) => {
    setInput(text)
    void saveDraft(archive.id, text, archive.navigationEpoch ?? 0).catch((error) =>
      notify(friendlyError(error), true),
    )
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
    setPreparing(true)
    controller.current = new AbortController()
    onBusy(true)
    clearError()
    finishedMessage.current = null
    let finishOperation!: () => void
    const operationFinished = new Promise<void>((resolve) => {
      finishOperation = resolve
    })
    const unregister = registerGameOperation(archive.id, async () => {
      controller.current?.abort()
      await operationFinished
    })
    try {
      return await withArchiveOperation(archive.id, async (lease) => {
        if (controller.current?.signal.aborted) throw new DOMException('已取消', 'AbortError')
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
          {
            body: {
              kind,
              operationOwner: lease.owner,
              operationFinished,
              operationSignal: controller.current?.signal,
              channelId: channel.id,
              personaId: persona?.id ?? '',
            },
          },
        )
        await transport.waitForIdle()
        const complete = finishedMessage.current
          ? await db.messages.get(finishedMessage.current)
          : undefined
        return complete?.status === 'complete' && !complete.stale && complete.reply?.kind === kind
      })
    } catch (e) {
      notify(friendlyError(e), true)
      return false
    } finally {
      unregister()
      finishOperation()
      lock.current = false
      setPreparing(false)
      controller.current = null
      onBusy(false)
      try {
        setMessages((await archiveMessages(archive.id)).slice(-visibleLimit).map(toChatMessage))
      } catch (e) {
        notify(friendlyError(e), true)
      }
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
    const sourceIndex = stored.findIndex((m) => m.id === sourceMessage)
    if (sourceIndex >= 0 && stored.length - sourceIndex > visibleLimit) {
      setVisibleLimit(stored.length - sourceIndex + 5)
      return
    }
    if (sourceIndex >= 0 && !messages.some((m) => m.id === sourceMessage)) return
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
  }, [sourceMessage, sourceBlock, busy, notify, onSourceHandled, visibleLimit, stored, messages])
  const replyToForum = async (id: string, text: string) => {
    if (busy || lock.current) return
    lock.current = true
    setForumRunning(true)
    setForumPartial('')
    controller.current = new AbortController()
    try {
      const task = await executeAuxiliary(archive.id, 'forumReply', text, id, {
        signal: controller.current!.signal,
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
    setPreparing(true)
    controller.current = new AbortController()
    onBusy(true)
    clearError()
    let finishOperation!: () => void
    const operationFinished = new Promise<void>((resolve) => {
      finishOperation = resolve
    })
    const unregister = registerGameOperation(archive.id, async () => {
      controller.current?.abort()
      await operationFinished
    })
    try {
      await withArchiveOperation(archive.id, async (lease) => {
        const all = await archiveMessages(archive.id)
        const target = all.findIndex((m) => m.id === id)
        await regenerate({
          messageId: id,
          body: {
            regenerateFromId: id,
            kind: all[target]?.kind === 'forum' ? 'forum' : 'narrative',
            operationOwner: lease.owner,
            operationFinished,
            operationSignal: controller.current?.signal,
            channelId: channel.id,
            personaId: persona?.id ?? '',
          },
        })
        await transport.waitForIdle()
      })
    } catch (e) {
      notify(friendlyError(e), true)
    } finally {
      unregister()
      finishOperation()
      lock.current = false
      setPreparing(false)
      controller.current = null
      onBusy(false)
      try {
        setMessages((await archiveMessages(archive.id)).slice(-visibleLimit).map(toChatMessage))
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
    let finishOperation!: () => void
    const operationFinished = new Promise<void>((resolve) => {
      finishOperation = resolve
    })
    const unregister = registerGameOperation(archive.id, async () => {
      controller.current?.abort()
      await operationFinished
    })
    try {
      await withArchiveOperation(archive.id, async () => {
        const current = await db.archives.get(archive.id)
        if (current)
          await compressArchive(
            current,
            channel,
            persona,
            await archiveMessages(archive.id),
            controller.current!.signal,
            mode,
            (d) => notify(d),
            true,
          )
        notify('上下文压缩完成，原文保留。')
      })
    } catch (e) {
      notify(friendlyError(e), true)
    } finally {
      unregister()
      finishOperation()
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
      await transport.waitForIdle()
      if (!compressing)
        await persistCancelledMessage(archive.id, messages.at(-1), archive.navigationEpoch ?? 0)
      await db.persistence.flush()
      setMessages((await archiveMessages(archive.id)).slice(-visibleLimit).map(toChatMessage))
    } catch (e) {
      notify(friendlyError(e), true)
    } finally {
      onBusy(false)
    }
  }
  const summaryJson = JSON.stringify(
    archive.summary?.revision === archive.revision ? archive.summary : undefined,
  )
  const budget = useMemo(
    () =>
      channel
        ? contextBudget(
            channel,
            persona,
            mode,
            stored,
            summaryJson ? (JSON.parse(summaryJson) as Summary) : undefined,
            archive.content,
          )
        : undefined,
    [channel, persona, mode, stored, summaryJson, archive.content],
  )
  const latestStatus = messages.at(-1)?.parts.find((p) => p.type === 'data-status')
  const copy = (message: ChatMessage, raw = false) => {
    const source = stored.find((m) => m.id === message.id)
    const live = message.parts.find(
      (part) => part.type === 'data-narrative' || part.type === 'data-forum',
    )
    const reply =
      live?.type === 'data-narrative'
        ? { kind: 'narrative' as const, value: live.data }
        : live?.type === 'data-forum'
          ? { kind: 'forum' as const, value: live.data }
          : source?.reply || source?.partial
    const text =
      raw && reply
        ? source?.rawContent || JSON.stringify(reply.value, null, 2)
        : reply?.kind === 'narrative'
          ? reply.value.blocks
              ?.filter(Boolean)
              .map(
                (block) => block!.text + (block!.translation ? `\n「${block!.translation}」` : ''),
              )
              .join('\n\n') || ''
          : reply?.kind === 'forum'
            ? [
                reply.value.post?.title,
                reply.value.post?.content,
                ...(reply.value.answers
                  ?.filter(Boolean)
                  .map((answer) => `${answer!.author}：${answer!.content}`) || []),
              ]
                .filter(Boolean)
                .join('\n\n')
            : source?.content ||
              message.parts
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n')
    void navigator.clipboard.writeText(text).then(
      () => notify(raw ? '原始数据已复制。' : '消息已复制。'),
      () => notify('复制失败，请使用浏览器的文本选择功能。', true),
    )
  }
  return (
    <MessageScrollerProvider autoScroll={chatBusy} defaultScrollPosition="end">
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
        <MessageScroller>
          <MessageScrollerViewport aria-label="聊天记录">
            <MessageScrollerContent className="mx-auto w-full reading-width px-4 py-8 sm:px-6">
              {stored.length > visibleLimit && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setVisibleLimit((count) => count + 60)}
                >
                  加载较早消息（还有 {stored.length - visibleLimit} 条）
                </Button>
              )}
              {messages.map((message, i) => (
                <MessageScrollerItem
                  key={message.id}
                  messageId={message.id}
                  scrollAnchor={message.role === 'user'}
                >
                  <article
                    id={`message-${message.id}`}
                    tabIndex={-1}
                    aria-label={message.role === 'user' ? '你的消息' : '宴雎的回复'}
                    className={
                      message.role === 'user'
                        ? 'animate-message'
                        : 'animate-message border-l-(length:--border-width) border-primary-border pl-4'
                    }
                  >
                    <Message align={message.role === 'user' ? 'end' : 'start'}>
                      <MessageContent>
                        <MessageHeader>
                          <span className="flex min-w-0 flex-wrap items-center gap-2">
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
                        <RecoveryBoundary
                          resetKey={JSON.stringify(message.parts)}
                          title="这条消息暂时无法显示"
                        >
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
                                  const key = 'id' in p ? `${p.type}:${p.id}` : `${p.type}:${j}`
                                  if (p.type === 'data-narrative')
                                    return (
                                      <MemoNarrativeView
                                        key={key}
                                        reply={p.data}
                                        messageId={message.id}
                                      />
                                    )
                                  if (p.type === 'data-forum')
                                    return (
                                      <MemoForumView
                                        key={key}
                                        reply={
                                          story?.forums.find(
                                            (f) => f.source.messageId === message.id,
                                          ) ?? p.data
                                        }
                                        disabled={
                                          busy ||
                                          stored.find((m) => m.id === message.id)?.stale ||
                                          !channel ||
                                          !channelIsReady(channel)
                                        }
                                        onReply={(id, text) => void replyToForum(id, text)}
                                        onSend={(text) => void send(text, 'forum')}
                                      />
                                    )
                                  if (p.type === 'data-notice')
                                    return (
                                      <img
                                        key={key}
                                        src={p.data}
                                        alt="角色设定提示"
                                        className="max-w-full rounded-lg"
                                        loading="lazy"
                                      />
                                    )
                                  if (p.type === 'text') return <Prose key={key} text={p.text} />
                                  return null
                                })}
                              </BubbleContent>
                            </Bubble>
                          )}
                        </RecoveryBoundary>
                        <RequestDetails value={message.metadata?.diagnostics} />
                        {message.metadata?.error && (
                          <p role="alert" className="text-sm text-destructive">
                            {message.metadata.error}
                          </p>
                        )}
                        <MessageFooter>
                          <div className="flex flex-wrap gap-1">
                            <IconButton
                              label={
                                message.parts.some((part) => part.type === 'data-narrative')
                                  ? '复制正文'
                                  : '复制消息'
                              }
                              onClick={() => copy(message)}
                            >
                              <Copy />
                            </IconButton>
                            {message.parts.some(
                              (part) =>
                                part.type === 'data-narrative' || part.type === 'data-forum',
                            ) && (
                              <IconButton label="复制原始数据" onClick={() => copy(message, true)}>
                                <FileJson />
                              </IconButton>
                            )}
                            <IconButton
                              label="编辑消息"
                              disabled={busy}
                              onClick={() => {
                                const m = stored.find((m) => m.id === message.id)
                                if (m) {
                                  setEditing(m)
                                }
                              }}
                            >
                              <Pencil />
                            </IconButton>
                            {message.role === 'assistant' &&
                              message.metadata?.status === 'complete' && (
                                <IconButton
                                  label="回退到此处"
                                  onClick={() => {
                                    void nodeForMessage(archive.id, message.id)
                                      .then((node) => navigateGame(archive.id, node.id))
                                      .catch((error) => notify(friendlyError(error), true))
                                  }}
                                >
                                  <RotateCcw />
                                </IconButton>
                              )}
                            <IconButton
                              label="从此分叉"
                              disabled={
                                message.role !== 'assistant' ||
                                message.metadata?.status !== 'complete'
                              }
                              onClick={() => {
                                void nodeForMessage(archive.id, message.id)
                                  .then((node) => forkGame(archive.id, node.id))
                                  .then(() => notify('新路线已建立。'))
                                  .catch((error) => notify(friendlyError(error), true))
                              }}
                            >
                              <GitBranch />
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
              {(!channel || !channelIsReady(channel)) && (
                <Alert role="status">
                  <AlertTitle>连接模型后，故事就能继续</AlertTitle>
                  <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                    <span>可以先阅读开场、写下回应，草稿会自动保存。</span>
                    <Button variant="outline" onClick={onChannels}>
                      配置并测试渠道
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
              {forumRunning && forumPartial && <Prose text={forumPartial} />}
              {chatBusy && (
                <div
                  role="status"
                  aria-live="polite"
                  className="panel-glass edge-accent flex items-center gap-3 border-(length:--border-width) border-primary-border p-4 text-ui text-primary"
                >
                  <span
                    aria-hidden="true"
                    className="size-3 rotate-45 border-(length:--border-width) border-primary animate-spin"
                  />
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
        </MessageScroller>
        <footer className="composer-surface safe-bottom shrink-0 border-t-(length:--border-width) px-3 pt-2 sm:px-6 sm:pt-3">
          <div className="mx-auto flex reading-width flex-col gap-2">
            <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                {channelControl}
                <Select
                  value={mode}
                  onValueChange={(v) => setMode(v as RequestKind)}
                  disabled={busy}
                >
                  <SelectTrigger aria-label="聊天模式">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="narrative">叙事</SelectItem>
                      <SelectItem value="forum">论坛</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                <IconButton label="打开剧情工作台" onClick={onStudio}>
                  <BookOpen />
                </IconButton>
                <IconButton label="世界、指令与音乐" onClick={onWorld}>
                  <BookOpen />
                </IconButton>
                <IconButton label="清空当前聊天" disabled={busy} onClick={() => setClear(true)}>
                  <Trash2 />
                </IconButton>
                {budget && (
                  <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground sm:ml-2">
                    <Button
                      variant="ghost"
                      onClick={() => setContextOpen(true)}
                      aria-label="查看上下文详情"
                    >
                      <span className="hidden sm:inline">上下文约</span>{' '}
                      {Math.round(budget.percent * 100)}%
                    </Button>
                    <IconButton label="压缩上下文" disabled={busy} onClick={() => void compress()}>
                      <ArrowDownToLine />
                    </IconButton>
                  </div>
                )}
              </div>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (!composing.current) {
                  inputRef.current?.focus({ preventScroll: true })
                  void send()
                }
              }}
            >
              <InputGroup>
                <InputGroupTextarea
                  id="chat-input"
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
                      (!touchInput || e.ctrlKey || e.metaKey) &&
                      !e.nativeEvent.isComposing &&
                      !composing.current &&
                      e.keyCode !== 229
                    ) {
                      e.preventDefault()
                      if (!busy) void send()
                    }
                  }}
                  className="composer-height resize-none overflow-y-auto"
                  rows={2}
                  placeholder={mode === 'forum' ? '输入帖子或回复内容…' : '写下你的回应…'}
                />
                <InputGroupAddon align="block-end" className="justify-between">
                  <div className="flex min-w-0 items-center gap-1">
                    <MessageScrollerButton
                      aria-label="回到最新消息"
                      title="回到最新消息"
                      size="icon"
                    />
                    <SaveStatus notify={notify} />
                  </div>
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
                      disabled={busy || !input.trim() || !channel || !channelIsReady(channel)}
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
        <Dialog open={contextOpen} onOpenChange={setContextOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>上下文与摘要</DialogTitle>
              <DialogDescription>
                接近容量上限时会自动整理旧对话，完整聊天记录会保留。
              </DialogDescription>
            </DialogHeader>
            {budget && (
              <div className="flex flex-col gap-3">
                <p className="text-ui tabular-nums">
                  预计输入 {budget.estimated.toLocaleString('zh-CN')} /{' '}
                  {channel!.contextWindow.toLocaleString('zh-CN')} tokens ·{' '}
                  {Math.round(budget.percent * 100)}%
                </p>
                <Progress aria-label="估算上下文占用" value={Math.min(100, budget.percent * 100)} />
                {archive.lastUsage && (
                  <p className="text-sm tabular-nums">
                    上次实际输入 {archive.lastUsage.input.toLocaleString('zh-CN')} · 输出{' '}
                    {archive.lastUsage.output.toLocaleString('zh-CN')} tokens
                  </p>
                )}
                <p className="text-sm text-muted-foreground">
                  {archive.summary
                    ? `摘要已覆盖 ${archive.summary.coveredCount} 条消息。`
                    : '当前还没有压缩摘要。'}
                </p>
                {archive.summary && <Prose text={archive.summary.value.summary} />}
                <Button
                  disabled={busy}
                  onClick={() => {
                    setContextOpen(false)
                    void compress()
                  }}
                >
                  整理并压缩历史
                </Button>
              </div>
            )}
          </DialogContent>
        </Dialog>
        {editing && (
          <MessageEditor
            key={editing.id}
            message={editing}
            disabled={busy}
            onClose={() => setEditing(null)}
            onSaved={() => notify('消息已更新。')}
          />
        )}
        <ConfirmDialog
          open={!!regenId}
          onClose={() => setRegenId('')}
          title="从这里重新生成？"
          detail="成功后建立新路线，原路线的后续进度保留。生成失败或取消会保留原聊天，并保存收到的部分内容。"
          destructive={false}
          onConfirm={() => {
            void retry(regenId)
          }}
        />
        <ConfirmDialog
          open={clear}
          onClose={() => setClear(false)}
          title="清空当前聊天？"
          detail="从指定开局创建新的路线，原路线和存档保留。"
          onConfirm={async () => {
            if (busy || lock.current) return
            const session = await db.sessions.get(archive.id)
            if (!session) throw new Error('开局存档尚未创建。')
            await forkGame(archive.id, session.startNodeId, '从开局重新开始')
            notify('已从开局创建新路线。')
          }}
        />
      </div>
    </MessageScrollerProvider>
  )
}

export const MemoNarrativeView = memo(NarrativeView)

export const MemoForumView = memo(ForumView)
