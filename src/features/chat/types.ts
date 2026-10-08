import type { RequestKind } from '@/lib/schemas'

export interface ExternalChatRequest {
  id: string
  text: string
  kind: RequestKind
  expectedRevision?: number
  complete: (committed: boolean) => void
}
