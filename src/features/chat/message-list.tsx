import { Button } from '@/components/ui/button'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller'
import { LoaderCircle } from 'lucide-react'

import { MessageItem } from './message-item'
import type { ChatSessionState } from './use-chat-session'

export function MessageList({ session }: { session: ChatSessionState }) {
  const { archive, messages, busy, compress, compressing, latestStatus } = session
  return (
    <>
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
                  <MessageItem
                    message={message}
                    index={i}
                    last={i === messages.length - 1}
                    session={session}
                  />
                </MessageScrollerItem>
              ))}
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
    </>
  )
}
