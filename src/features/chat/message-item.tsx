import { IconButton, Prose } from '@/components/shared'
import { Badge } from '@/components/ui/badge'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageContent, MessageFooter, MessageHeader } from '@/components/ui/message'
import type { ChatMessage } from '@/lib/types'
import { Copy, Pencil, RotateCcw } from 'lucide-react'
import { ForumView } from './replies/forum-view'
import { NarrativeView } from './replies/narrative-view'

import type { ChatSessionState } from './use-chat-session'

export function MessageItem({
  message,
  index,
  last,
  session,
}: {
  message: ChatMessage
  index: number
  last: boolean
  session: ChatSessionState
}) {
  const { persona, busy, send, copy, startEdit, setRegenId, retry } = session
  return (
    <article aria-label={message.role === 'user' ? '你的消息' : '宴雎的回复'}>
      <Message align={message.role === 'user' ? 'end' : 'start'}>
        <MessageContent>
          <MessageHeader>
            <span className="flex items-center gap-2">
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
                  if (p.type === 'data-narrative') return <NarrativeView key={j} reply={p.data} />
                  if (p.type === 'data-forum')
                    return (
                      <ForumView
                        key={j}
                        reply={p.data}
                        disabled={busy}
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
                <Copy data-icon="inline-start" />
              </IconButton>
              <IconButton label="编辑消息" disabled={busy} onClick={() => startEdit(message.id)}>
                <Pencil data-icon="inline-start" />
              </IconButton>
              {message.role === 'assistant' && index > 0 && (
                <IconButton
                  label={
                    message.metadata?.status === 'failed' ||
                    message.metadata?.status === 'cancelled'
                      ? '重试回复'
                      : '重新生成'
                  }
                  disabled={busy}
                  onClick={() => {
                    if (!last) setRegenId(message.id)
                    else void retry(message.id)
                  }}
                >
                  <RotateCcw data-icon="inline-start" />
                </IconButton>
              )}
            </div>
          </MessageFooter>
        </MessageContent>
      </Message>
    </article>
  )
}
