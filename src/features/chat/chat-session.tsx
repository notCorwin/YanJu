import { archiveMessages } from '@/lib/storage'
import { useLiveQuery } from 'dexie-react-hooks'
import { ChatComposer } from './chat-composer'
import { MessageDialogs } from './message-dialogs'
import { MessageList } from './message-list'
import type { ChatRunnerProps, ChatSessionProps } from './types'
import { useChatSession } from './use-chat-session'

export function ChatSession(props: ChatSessionProps) {
  const stored = useLiveQuery(() => archiveMessages(props.archive.id), [props.archive.id])
  if (!stored)
    return (
      <p role="status" className="p-6 text-muted-foreground">
        正在读取存档…
      </p>
    )
  return <ChatRunner {...props} stored={stored} />
}
function ChatRunner(props: ChatRunnerProps) {
  const session = useChatSession(props)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MessageList session={session} />
      <ChatComposer session={session} onWorld={props.onWorld} />
      <MessageDialogs session={session} />
    </div>
  )
}
