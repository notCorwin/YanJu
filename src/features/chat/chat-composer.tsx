import { IconButton } from '@/components/shared'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { friendlyError } from '@/lib/provider'
import type { RequestKind } from '@/lib/schemas'
import { BookOpen, Send, Square, Trash2 } from 'lucide-react'

import { ContextActions, ContextStatus } from './context-status'
import type { ChatSessionState } from './use-chat-session'

export function ChatComposer({
  session,
  onWorld,
}: {
  session: ChatSessionState
  onWorld: () => void
}) {
  const {
    mode,
    setMode,
    busy,
    setClear,
    input,
    composingRef,
    inputRef,
    draft,
    send,
    stopGeneration,
    error,
  } = session
  return (
    <footer className="surface safe-bottom shrink-0 border-t-(length:--border-width) px-3 pt-3 sm:px-6">
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
              <BookOpen data-icon="inline-start" />
            </IconButton>
            <IconButton label="清空当前聊天" disabled={busy} onClick={() => setClear(true)}>
              <Trash2 data-icon="inline-start" />
            </IconButton>
          </div>
          <ContextActions session={session} />
        </div>
        <ContextStatus session={session} />
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!composingRef.current) void send()
          }}
        >
          <InputGroup>
            <InputGroupTextarea
              ref={inputRef}
              aria-label="聊天输入"
              value={input}
              onChange={(e) => draft(e.target.value)}
              onCompositionStart={() => {
                composingRef.current = true
              }}
              onCompositionEnd={() => {
                composingRef.current = false
              }}
              onKeyDown={(e) => {
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  !composingRef.current &&
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
              <span className="text-xs text-muted-foreground">Enter 发送 · Shift + Enter 换行</span>
              {busy ? (
                <InputGroupButton
                  aria-label="停止生成"
                  onClick={() => void stopGeneration()}
                  variant="secondary"
                  size="sm"
                >
                  <Square data-icon="inline-start" />
                  停止
                </InputGroupButton>
              ) : (
                <InputGroupButton
                  type="submit"
                  aria-label="发送消息"
                  variant="default"
                  size="sm"
                  disabled={!input.trim()}
                >
                  <Send data-icon="inline-start" />
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
  )
}
