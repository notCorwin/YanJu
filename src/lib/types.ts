import type { DeepPartial, UIMessage, ModelMessage } from 'ai'
import type { CompressionResult, ForumReply, NarrativeReply, Reply, RequestKind } from './schemas'
import type { TurnEffects } from './domain-schema'
import type { StoryState, StoryEvent } from './story'
import type { AuxiliaryKind, TaskInput, TaskKind } from './tasks'

export interface Channel {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxOutputTokens: number
  contextWindow: number
  createdAt: number
  capability?: { fingerprint: string; testedAt: number; ok: boolean; error?: string }
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
  autoMusic: boolean
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
  userName?: string
  description?: string
  keywords?: string[]
}
export type MessageStatus = 'complete' | 'partial' | 'failed' | 'cancelled'
export interface StoredMessage {
  id: string
  archiveId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  sequence: number
  kind: RequestKind | 'notice' | 'opening' | 'material' | 'interaction'
  status: MessageStatus
  reply?: Reply
  partial?:
    | { kind: 'narrative'; value: DeepPartial<NarrativeReply> }
    | { kind: 'forum'; value: DeepPartial<ForumReply> }
  rawContent?: string
  /** A user message already sent to correct this generation, replayed before the assistant reply. */
  correction?: string
  error?: string
  usage?: Usage
  stale?: boolean
  requestContext?: string
  effects?: TurnEffects
  userName?: string
  interaction?:
    | {
        kind: 'phone'
        contactRef: string
        userText: string
        speaker: string
        time: string
        text: string
      }
    | {
        kind: 'forum'
        postId: string
        replyTo: string
        userText: string
        author: string
        time: string
        content: string
      }
}
export interface TaskRun {
  id: string
  archiveId: string
  revision: number
  kind: AuxiliaryKind
  input: TaskInput
  channelId: string
  createdAt: number
  status: MessageStatus
  output?: unknown
  partial?: unknown
  raw?: string
  error?: string
  correction?: string
  usage?: Usage
  applied?: boolean
}
export interface RequestRecord {
  id: string
  archiveId: string | null
  ownerId: string | null
  kind: TaskKind
  attempt: number
  createdAt: number
  channel: { id: string; name: string; baseUrl: string; model: string }
  request: {
    instructions: string
    messages: ModelMessage[]
    schema: unknown
    maxOutputTokens: number
    temperature: number
  }
  estimatedInput: number
  status: MessageStatus
  output?: unknown
  partial?: unknown
  raw?: string
  error?: string
  usage?: Usage
}
export interface MessageMeta {
  createdAt: number
  kind: StoredMessage['kind']
  status: MessageStatus
  error?: string
}
export type ChatMessage = UIMessage<
  MessageMeta,
  {
    narrative: DeepPartial<NarrativeReply>
    forum: DeepPartial<ForumReply>
    notice: string
    status: {
      phase: 'compressing' | 'generating' | 'correcting' | 'complete' | 'failed' | 'cancelled'
      detail: string
    }
  },
  Record<string, never>
>
export interface SaveFile {
  version: 3
  exportedAt: string
  archives: Archive[]
  messages: StoredMessage[]
  channels: Channel[]
  masks: Persona[]
  settings: Settings
  storyStates: StoryState[]
  storyEvents: StoryEvent[]
  tasks: TaskRun[]
  requests: RequestRecord[]
}

export const defaults: Settings = {
  id: 'app',
  activeChannelId: '',
  activePersonaId: '',
  activeArchiveId: '',
  migrated: false,
  autoMusic: false,
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
