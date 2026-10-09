import type { ReactNode } from 'react'
import { ChatRunner } from '@/features/chat/chat-runner'
import type { ExternalChatRequest } from '@/features/chat/types'
import type { Notify } from '@/lib/notify'
import type { RequestKind } from '@/lib/schemas'
import { archiveMessages } from '@/lib/storage'
import type { Archive, Channel, Persona } from '@/lib/types'
import { useLiveQuery } from 'dexie-react-hooks'

export function ChatSession(props: {
  archive: Archive
  channel?: Channel
  channelControl: ReactNode
  applicationControl: ReactNode
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
