import type { Archive, Channel, Notify, Persona, StoredMessage } from '@/lib/types'

export interface ChatSessionProps {
  archive: Archive
  channel?: Channel
  persona?: Persona
  notify: Notify
  onBusy: (value: boolean) => void
  onWorld: () => void
  insert: string
  onInserted: () => void
}
export interface ChatRunnerProps extends ChatSessionProps {
  stored: StoredMessage[]
}
