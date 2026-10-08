import { IconButton } from '@/components/shared'
import { Progress } from '@/components/ui/progress'
import { ArrowDownToLine } from 'lucide-react'

import type { ChatSessionState } from './use-chat-session'

export function ContextActions({ session }: { session: ChatSessionState }) {
  const { budget, channel, busy, compress } = session
  if (!budget) return null
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>
        上下文约 {Math.round(budget.percent * 100)}% · {budget.estimated.toLocaleString()} /{' '}
        {channel!.contextWindow.toLocaleString()}
      </span>
      <IconButton label="压缩上下文" disabled={busy} onClick={() => void compress()}>
        <ArrowDownToLine data-icon="inline-start" />
      </IconButton>
    </div>
  )
}

export function ContextStatus({ session }: { session: ChatSessionState }) {
  const { budget, archive } = session
  return (
    <>
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
    </>
  )
}
