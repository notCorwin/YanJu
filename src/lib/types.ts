import type { DeepPartial, UIMessage } from 'ai'
import type { CompressionResult, ForumReply, NarrativeReply, Reply, RequestKind } from './schemas'

export interface Channel {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxOutputTokens: number
  contextWindow: number
  requestTimeoutMs?: number
  createdAt: number
  capability?: {
    fingerprint: string
    testedAt: number
    ok: boolean
    error?: string
    streaming?: boolean
    protocols?: boolean
    firstTokenMs?: number
    elapsedMs?: number
  }
  calibration?: { ratio: number; samples: number }
}
export interface Persona {
  id: string
  name: string
  gender: string
  identity: string
  prefer: string
  force: string
  createdAt: number
}
export interface Appearance {
  fontChat: number
  fontUi: number
  fontFamily: string
  bgImage: string
  bgOpacity: number
}
export interface Settings extends Appearance {
  id: 'app'
  activeChannelId: string
  activePersonaId: string
  activeArchiveId: string
  migrated: boolean
}
export interface Usage {
  input: number
  output: number
  total: number
  measuredAt: number
  estimatedInput: number
  channelId: string
}
export interface Summary {
  value: CompressionResult
  coveredThroughId: string
  coveredCount: number
  revision: number
  createdAt: number
}
export interface Archive {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  revision: number
  summary?: Summary
  lastUsage?: Usage
  draft: string
  compactionError?: string
}
export interface LegacyPanel {
  title: string
  sections: { heading: string; text: string }[]
}
export interface LegacyContent {
  body: string
  scene?: {
    time: string
    location: string
    characters: string
    quoteZh: string
    quoteEn: string
    source: string
  }
  panels: LegacyPanel[]
  forum?: ForumReply
}
export type MessageStatus = 'complete' | 'partial' | 'failed' | 'cancelled'
export interface RequestDiagnostics {
  startedAt: number
  elapsedMs: number
  firstTokenMs?: number
  requestId?: string
  httpStatus?: number
  corrections: number
  model: string
  schema: string
  finishReason?: string
}
export interface StoredMessage {
  id: string
  archiveId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  sequence: number
  kind: RequestKind | 'legacy' | 'notice'
  status: MessageStatus
  reply?: Reply
  partial?:
    | { kind: 'narrative'; value: DeepPartial<NarrativeReply> }
    | { kind: 'forum'; value: DeepPartial<ForumReply> }
  legacy?: LegacyContent
  rawContent?: string
  /** A user message already sent to correct this generation, replayed before the assistant reply. */
  correction?: string
  error?: string
  usage?: Usage
  diagnostics?: RequestDiagnostics
}
export interface MessageMeta {
  createdAt: number
  kind: StoredMessage['kind']
  status: MessageStatus
  error?: string
  diagnostics?: RequestDiagnostics
}
export type ChatMessage = UIMessage<
  MessageMeta,
  {
    narrative: DeepPartial<NarrativeReply>
    forum: DeepPartial<ForumReply>
    legacy: LegacyContent
    notice: string
    status: {
      phase: 'compressing' | 'generating' | 'correcting' | 'complete' | 'failed' | 'cancelled'
      detail: string
    }
  },
  Record<string, never>
>
export interface SaveFile {
  version: 2
  exportedAt: string
  archives: Archive[]
  messages: StoredMessage[]
  channels: Channel[]
  masks: Persona[]
  settings: Settings
}

export const defaults: Settings = {
  id: 'app',
  activeChannelId: '',
  activePersonaId: '',
  activeArchiveId: '',
  migrated: false,
  fontChat: 16,
  fontUi: 14,
  fontFamily: 'Noto Serif SC',
  bgImage: '',
  bgOpacity: 15,
}
export const newChannel = (): Channel => ({
  id: crypto.randomUUID(),
  name: '新渠道',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  temperature: 0.9,
  maxOutputTokens: 4096,
  contextWindow: 32768,
  requestTimeoutMs: 300000,
  createdAt: Date.now(),
})
export const newPersona = (): Persona => ({
  id: crypto.randomUUID(),
  name: '沈辞玉',
  gender: '女',
  identity: '申海旧家之女',
  prefer: '',
  force: '不允许代替我说话、行动或做决定。',
  createdAt: Date.now(),
})
