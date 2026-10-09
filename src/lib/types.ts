import type { DeepPartial, UIMessage, ModelMessage } from 'ai'
import type { CompressionResult, ForumReply, NarrativeReply, Reply, RequestKind } from './schemas'
import type { TurnEffects } from './domain-schema'
import type { StoryState, StoryEvent } from './story'
import type { AuxiliaryKind, TaskInput, TaskKind } from './tasks'

export const apiProtocols = [
  'chat-completions',
  'completions',
  'responses',
  'messages',
  'generate-content',
  'interactions',
  'google-chat-completions',
  'native',
] as const
export type ApiProtocol = (typeof apiProtocols)[number]
export type ApiMode = 'auto' | ApiProtocol
export const outputModes = ['structured', 'json', 'prompt'] as const
export type OutputMode = (typeof outputModes)[number]
export interface ProtocolCapability {
  nonStreaming: 'passed' | 'failed' | 'untested'
  streaming: 'passed' | 'failed' | 'untested'
  error?: string
  outputMode?: OutputMode
  streamingOutputMode?: OutputMode
}
export interface ChannelCapability {
  fingerprint: string
  catalogFingerprint?: string
  testedAt: number
  ok: boolean
  protocol?: ApiProtocol
  checks?: Partial<Record<ApiProtocol, ProtocolCapability>>
  error?: string
  protocols?: boolean
  firstTokenMs?: number
  elapsedMs?: number
}
export interface Channel {
  id: string
  name: string
  connectionMode: 'catalog' | 'custom'
  providerId: string
  modelProviderId: string
  sdk: string
  baseUrl: string
  apiKey: string
  model: string
  apiMode: ApiMode
  temperature: number | null
  contextWindow: number
  inputLimit?: number
  temperatureSupported?: boolean
  createdAt: number
  capability?: ChannelCapability
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
  content?: StoryContent
  persona?: Persona
  navigationEpoch?: number
  deletedMessageIds?: string[]
}
export interface StoryContent {
  character: string
  rules: string
  style: string
  opening: string
  world: { label: string; text: string }[]
  entities: {
    id: string
    kind: 'character' | 'location' | 'organization'
    name: string
    description: string
  }[]
  background: string
}
export interface GameSession {
  id: string
  branchId: string
  nodeId: string
  startNodeId: string
  detached?: boolean
}
export interface Branch {
  id: string
  archiveId: string
  name: string
  headId: string
  forkNodeId?: string
  createdAt: number
  recovery?: RecoveryState
}
export interface RecoveryState {
  nodeId: string
  archive: Omit<Archive, 'content' | 'persona'>
  contextId: string
  messageIds: string[]
  taskIds: string[]
  stateId: string
}
export interface HistoryNode {
  id: string
  archiveId: string
  branchId: string
  parentId?: string
  createdAt: number
  label: string
  messageIds: string[]
  taskIds: string[]
  contextId: string
  stateId: string
  archive: Omit<Archive, 'content' | 'persona'>
}
export interface GameContext {
  id: string
  archiveId: string
  content: StoryContent
  persona?: Persona
}
export interface MessageVersion {
  id: string
  archiveId: string
  value: StoredMessage
}
export interface TaskVersion {
  id: string
  archiveId: string
  value: TaskRun
}
export interface StateVersion {
  id: string
  archiveId: string
  state: StoryState
}
export interface SaveSlot {
  id: string
  archiveId: string
  branchId: string
  nodeId: string
  name: string
  kind: 'auto' | 'manual' | 'quick'
  createdAt: number
  recovery?: RecoveryState
}
export interface GameHistory {
  sessions: GameSession[]
  branches: Branch[]
  nodes: HistoryNode[]
  contexts: GameContext[]
  messageVersions: MessageVersion[]
  taskVersions: TaskVersion[]
  slots: SaveSlot[]
  stateVersions: StateVersion[]
}
export type MessageStatus = 'complete' | 'partial' | 'failed' | 'cancelled'
export interface RequestDiagnostics {
  startedAt: number
  elapsedMs: number
  firstTokenMs?: number
  requestId?: string
  httpStatus?: number
  corrections: number
  outputMode?: OutputMode
  fallbacks?: number
  repairs?: number
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
  diagnostics?: RequestDiagnostics
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
  navigationEpoch?: number
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
  diagnostics?: RequestDiagnostics
  applied?: boolean
}
export interface RequestRecord {
  id: string
  archiveId: string | null
  ownerId: string | null
  kind: TaskKind
  attempt: number
  createdAt: number
  channel: { id: string; name: string; baseUrl: string; model: string; protocol: ApiProtocol }
  request: {
    instructions: string
    messages: ModelMessage[]
    schema: unknown
    temperature: number | null
    streaming: boolean
    outputMode?: OutputMode
  }
  estimatedInput: number
  status: MessageStatus
  output?: unknown
  partial?: unknown
  raw?: string
  error?: string
  usage?: Usage
  diagnostics?: RequestDiagnostics
}
export interface MessageMeta {
  diagnostics?: RequestDiagnostics
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
  version: 4
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
  history: GameHistory
}

export const defaults: Settings = {
  id: 'app',
  activeChannelId: '',
  activePersonaId: '',
  activeArchiveId: '',
  migrated: false,
  autoMusic: false,
  fontChat: 14,
  fontUi: 12,
  fontFamily: 'Noto Serif TC',
  bgImage: '',
  bgOpacity: 15,
}
export const newChannel = (): Channel => ({
  id: crypto.randomUUID(),
  name: '新渠道',
  connectionMode: 'catalog',
  providerId: '',
  modelProviderId: '',
  sdk: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  apiMode: 'auto',
  temperature: null,
  contextWindow: 0,
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
