import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useChat } from '@ai-sdk/react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  contextArchiveMessages,
  recentArchiveMessages,
  db,
  forkArchive,
  createArchiveData,
  revise,
} from '@/lib/db'
import { BrowserChatTransport, toChatMessage } from '@/lib/transport'
import { contextBudget } from '@/lib/context'
import { channelIsReady, friendlyError } from '@/lib/provider'
import { useChatOperations } from '@/hooks/use-chat-operations'
import { withArchiveOperation } from '@/lib/operations'
import type { Archive, Channel, ChatMessage, Persona, StoredMessage, Summary } from '@/lib/types'
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
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
  SelectItem,
  SelectGroup,
} from './ui/select'
import { Alert, AlertTitle, AlertDescription } from './ui/alert'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog'
import { NarrativeView, ForumView, LegacyView } from './replies'
import { RecoveryBoundary } from './recovery-boundary'
import { MessageEditor } from './message-editor'
import { RequestDetails } from './request-details'
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
  GitBranch,
  FileJson,
} from 'lucide-react'

export function ChatSession(props: {
  archive: Archive
  channel?: Channel
  persona?: Persona
  notify: Notify
  onBusy: (value: boolean) => void
  onWorld: () => void
  onChannels: () => void
  insert: string
  onInserted: () => void
}) {
  const [limit, setLimit] = useState(60)
  const stored = useLiveQuery(
    () => recentArchiveMessages(props.archive.id, limit),
    [props.archive.id, limit],
  )
  const context = useLiveQuery(
    () => contextArchiveMessages(props.archive),
    [props.archive.id, props.archive.revision, props.archive.summary?.createdAt],
  )
  const loadEarlier = useCallback(() => setLimit((value) => value + 60), [])
  if (!stored || !context)
    return (
      <p role="status" className="p-6 text-muted-foreground">
        正在读取存档…
      </p>
    )
  return (
    <ChatRunner
      {...props}
      stored={stored.messages}
      context={context}
      limit={limit}
      remaining={stored.count - stored.messages.length}
      onLoadEarlier={loadEarlier}
    />
  )
}
function ChatRunner({
  archive,
  channel,
  persona,
  notify,
  onBusy,
  onWorld,
  onChannels,
  stored,
  context,
  limit,
  remaining,
  onLoadEarlier,
  insert,
  onInserted,
}: {
  archive: Archive
  channel?: Channel
  persona?: Persona
  notify: Notify
  onBusy: (value: boolean) => void
  onWorld: () => void
  onChannels: () => void
  stored: StoredMessage[]
  context: StoredMessage[]
  limit: number
  remaining: number
  onLoadEarlier: () => void
  insert: string
  onInserted: () => void
}) {
  const transport = useMemo(() => new BrowserChatTransport(), [])
  const initialMessages = useMemo(() => stored.map(toChatMessage), [stored])
  const chat = useChat<ChatMessage>({
    id: archive.id,
    transport,
    messages: initialMessages,
    generateId: () => crypto.randomUUID(),
    onError: (e) => notify(friendlyError(e), true),
  })
  const [mode, setMode] = useState<RequestKind>('narrative')
  const [contextOpen, setContextOpen] = useState(false)
  const [editing, setEditing] = useState<StoredMessage | null>(null)
  const [regenId, setRegenId] = useState('')
  const [clear, setClear] = useState(false)
  const { messages, setMessages, error } = chat
  const {
    input,
    draft,
    inputRef,
    send,
    retry,
    compress,
    stopGeneration,
    busy,
    compressing,
    localLock: lock,
  } = useChatOperations({
    archive,
    channel,
    persona,
    mode,
    limit,
    chat,
    notify,
    onBusy,
    settle: transport.waitForIdle,
  })
  const composing = useRef(false)
  const touchInput = useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia('(pointer: coarse)')
      query.addEventListener('change', notify)
      return () => query.removeEventListener('change', notify)
    },
    () => window.matchMedia('(pointer: coarse)').matches,
  )
  useEffect(() => {
    if (!lock.current && !busy) setMessages(stored.map(toChatMessage))
  }, [stored, busy, setMessages, lock])
  useEffect(() => {
    if (insert) {
      draft(input ? `${input}\n${insert}` : insert)
      onInserted()
      inputRef.current?.focus()
    }
  }, [insert, input, draft, inputRef, onInserted])
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
            context,
            summaryJson ? (JSON.parse(summaryJson) as Summary) : undefined,
          )
        : undefined,
    [channel, persona, mode, context, summaryJson],
  )
  const onForumSend = useCallback(
    (text: string) => {
      void send(text, 'forum')
    },
    [send],
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
            : source?.legacy?.body ||
              source?.content ||
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
      <MessageScrollerProvider autoScroll={busy} defaultScrollPosition="end">
        <MessageScroller>
          <MessageScrollerViewport aria-label="聊天记录">
            <MessageScrollerContent className="mx-auto w-full reading-width px-4 py-8 sm:px-6">
              {remaining > 0 && (
                <Button variant="outline" disabled={busy} onClick={onLoadEarlier}>
                  加载较早消息（还有 {remaining} 条）
                </Button>
              )}
              {messages.map((message, i) => (
                <MessageScrollerItem
                  key={message.id}
                  messageId={message.id}
                  scrollAnchor={message.role === 'user'}
                >
                  <article aria-label={message.role === 'user' ? '你的消息' : '宴雎的回复'}>
                    <Message align={message.role === 'user' ? 'end' : 'start'}>
                      <MessageContent>
                        <MessageHeader>
                          <span className="flex min-w-0 flex-wrap items-center gap-2">
                            {message.role === 'user' ? persona?.name || '你' : '宴雎'}
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
                                  ? busy
                                    ? '生成中'
                                    : '未完成'
                                  : message.metadata.status === 'cancelled'
                                    ? '已停止'
                                    : '待恢复'}
                              </Badge>
                            )}
                          </span>
                        </MessageHeader>
                        <RecoveryBoundary resetKey={message.parts} title="这条消息暂时无法显示">
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
                                    return <MemoNarrativeView key={key} reply={p.data} />
                                  if (p.type === 'data-forum')
                                    return (
                                      <MemoForumView
                                        key={key}
                                        reply={p.data}
                                        disabled={busy || !channel || !channelIsReady(channel)}
                                        onSend={onForumSend}
                                      />
                                    )
                                  if (p.type === 'data-legacy')
                                    return (
                                      <MemoLegacyView
                                        key={key}
                                        value={p.data}
                                        disabled={busy || !channel || !channelIsReady(channel)}
                                        onSend={onForumSend}
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
                            <IconButton
                              label="从此分叉"
                              disabled={busy}
                              onClick={() => {
                                void withArchiveOperation(archive.id, () =>
                                  forkArchive(archive.id, message.id),
                                )
                                  .then((fork) => {
                                    window.location.hash = `/chat/${encodeURIComponent(fork.id)}`
                                  })
                                  .catch((error) => notify(friendlyError(error), true))
                              }}
                            >
                              <GitBranch />
                            </IconButton>
                            {message.role === 'assistant' && i > 0 && (
                              <IconButton
                                label={
                                  message.metadata?.status === 'failed' ||
                                  message.metadata?.status === 'partial' ||
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
              {busy && (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-2 text-ui text-primary"
                >
                  <LoaderCircle className="size-4 animate-spin" />
                  {compressing
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
      <footer className="surface safe-bottom shrink-0 border-t-(length:--border-width) px-3 pt-2 sm:px-6 sm:pt-3">
        <div className="mx-auto flex reading-width flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Select value={mode} onValueChange={(v) => setMode(v as RequestKind)} disabled={busy}>
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
              <IconButton label="世界、指令与音乐" onClick={onWorld}>
                <BookOpen />
              </IconButton>
              <IconButton label="清空当前聊天" disabled={busy} onClick={() => setClear(true)}>
                <Trash2 />
              </IconButton>
            </div>
            {budget && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
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
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!composing.current) void send()
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
                <span className="text-xs text-muted-foreground">
                  {touchInput ? (
                    '草稿自动保存 · 点击发送'
                  ) : (
                    <>
                      <span>Enter 发送</span>
                      <span className="hidden sm:inline"> · Shift + Enter 换行</span>
                    </>
                  )}
                </span>
                {busy ? (
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
                    disabled={!input.trim() || !channel || !channelIsReady(channel)}
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
          onClose={() => setEditing(null)}
          onSaved={() => notify('消息已更新。')}
        />
      )}
      <ConfirmDialog
        open={!!regenId}
        onClose={() => setRegenId('')}
        title="从这里重新生成？"
        detail="成功后将原分支保留为独立篇章，再替换这条回复及后续内容。生成失败或取消会保留原聊天，并保存收到的部分内容。"
        destructive={false}
        onConfirm={() => {
          void retry(regenId)
        }}
      />
      <ConfirmDialog
        open={clear}
        onClose={() => setClear(false)}
        title="清空当前聊天？"
        detail="将删除当前篇章的聊天和摘要，并恢复原开场白。其他存档保留。"
        onConfirm={async () => {
          const data = createArchiveData()
          await withArchiveOperation(archive.id, () =>
            db.transaction('rw', db.messages, db.archives, async () => {
              const current = await db.archives.get(archive.id)
              if (!current) throw new Error('存档不存在。')
              await db.messages.where('archiveId').equals(archive.id).delete()
              await db.messages.put({ ...data.opening, archiveId: archive.id })
              await db.archives.put({ ...revise(current, true), draft: '' })
            }),
          )
          draft('')
          notify('当前聊天已清空。')
        }}
      />
    </div>
  )
}

const MemoNarrativeView = memo(NarrativeView)
const MemoForumView = memo(ForumView)
const MemoLegacyView = memo(LegacyView)
