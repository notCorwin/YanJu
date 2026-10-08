import { z } from 'zod'
import type { Persona } from './types'
import type { StoryState } from './story'
import type { ModelMessage } from 'ai'
import { effectsSchema } from './domain-schema'
import {
  compressionSchema,
  forumSchema,
  narrativeSchema,
  validateNarrative,
  validateForum,
  validateCompression,
  validateEffects,
  ContentValidationError,
} from './schemas'

const text = z.string()
const nullable = text.nullable()
const object = z.strictObject
const source = object({ messageId: text, blockId: nullable })

export const taskSchemas = {
  narrative: narrativeSchema,
  forum: forumSchema,
  compression: compressionSchema,
  capability: object({
    ready: z.boolean(),
    echo: text,
    probe: object({
      mode: z.enum(['strict']),
      count: z.number().int(),
      samples: z.array(object({ label: text, note: nullable, enabled: z.boolean() })),
    }),
  }),
  forumReply: object({ postId: text, replyTo: text, author: text, time: text, content: text }),
  phoneReply: object({ contactRef: text, speaker: text, time: text, text }),
  search: object({
    entityRefs: z.array(text),
    terms: z.array(text),
    fromDate: nullable,
    toDate: nullable,
    category: z.enum(['all', 'event', 'memory', 'goal', 'diary', 'message']),
  }),
  persona: object({ name: text, gender: text, identity: text, prefer: text, force: text }),
  archiveMetadata: object({ name: text, summary: text, keywords: z.array(text) }),
  continuation: object({
    options: z.array(object({ id: text, title: text, action: text, scene: text })),
  }),
  rewrite: object({ replacement: narrativeSchema, changedBlockIds: z.array(text) }),
  consistency: object({
    summary: text,
    issues: z.array(
      object({
        type: z.enum(['character', 'time', 'location', 'knowledge', 'reference', 'other']),
        severity: z.enum(['info', 'warning', 'error']),
        source,
        evidence: text,
        suggestion: text,
      }),
    ),
  }),
  contentImport: object({
    title: text,
    summary: text,
    effects: effectsSchema,
    unrecognized: z.array(text),
  }),
  chapters: object({
    title: text,
    chapters: z.array(object({ title: text, summary: text, messageIds: z.array(text) })),
  }),
  media: object({
    trackId: nullable,
    reason: text,
    background: text,
    voice: z.array(object({ blockId: text, speaker: text, direction: text })),
  }),
  command: object({
    action: z.enum(['search', 'mode', 'music', 'archive', 'character', 'phone', 'world']),
    targetId: nullable,
    mode: z.enum(['narrative', 'forum']).nullable(),
    query: nullable,
    explanation: text,
  }),
} as const

export type TaskKind = keyof typeof taskSchemas
export type AuxiliaryKind = Exclude<TaskKind, 'narrative' | 'forum' | 'compression' | 'capability'>
export type TaskOutput<K extends TaskKind> = z.infer<(typeof taskSchemas)[K]>
export interface TaskInput {
  text: string
  targetId: string | null
  context: {
    archive: { id: string; name: string; summary?: TaskOutput<'compression'> }
    persona: Persona | null
    story: Pick<
      StoryState,
      | 'entities'
      | 'clock'
      | 'states'
      | 'relationships'
      | 'knowledge'
      | 'memories'
      | 'goals'
      | 'events'
    >
    target: TaskOutput<'narrative'> | TaskOutput<'forum'> | null
    phone: StoryState['phones'][number] | null
    forum: StoryState['forums'][number] | null
    archives: { id: string; name: string }[]
    tracks: { id: string; name: string }[]
    history: {
      id: string
      role: 'user' | 'assistant'
      text: string
      blocks: { id: string; text: string }[]
    }[]
  }
}

/** Input contracts are owned by the program; only each task's independent output schema is sent as response_format. */
export type TaskInputs = {
  narrative: { instructions: string; messages: ModelMessage[] }
  forum: { instructions: string; messages: ModelMessage[] }
  compression: {
    previous?: TaskOutput<'compression'>
    messages: { role: string; content: string }[]
    targetTokens: number
  }
  capability: { test: string }
} & {
  [K in AuxiliaryKind]: K extends 'phoneReply' | 'forumReply' | 'rewrite' | 'media'
    ? TaskInput & { targetId: string }
    : TaskInput
}

export const taskDefinitions: Record<
  TaskKind,
  {
    name: string
    label: string
    instructions: string
    commit: 'reply' | 'summary' | 'draft' | 'interaction' | 'query'
  }
> = {
  narrative: {
    name: 'NarrativeReply',
    label: '叙事',
    instructions: '生成完整叙事及本轮发生的剧情变化。',
    commit: 'reply',
  },
  forum: {
    name: 'ForumReply',
    label: '论坛新帖',
    instructions:
      '生成一个帖子和完整50条回答。回答 ID 唯一，replyTo 为回答引用或空字符串。用户帖子内容必须原样保留。',
    commit: 'reply',
  },
  compression: {
    name: 'CompressionResult',
    label: '压缩',
    instructions:
      '压缩所提供的历史，保留人物关系、时间地点、关键事件、决定、未完成事项和具体姓名数值。不能编造或产生新剧情；没有信息的列表返回 []。',
    commit: 'summary',
  },
  capability: {
    name: 'ChannelCapability',
    label: '渠道测试',
    instructions:
      'Return ready=true, echo="YanJu strict output", probe={mode:"strict",count:2,samples:[{label:"nested",note:null,enabled:true},{label:"array",note:"ok",enabled:false}]}.',
    commit: 'query',
  },
  forumReply: {
    name: 'ForumAppend',
    label: '论坛回复',
    instructions:
      '回复指定 postId 和 replyTo。生成恰好一条 NPC 回复，不代替用户发言，不重建帖子和其他回答。保留输入中的两个目标 ID。',
    commit: 'interaction',
  },
  phoneReply: {
    name: 'PhoneReply',
    label: '手机回复',
    instructions:
      '以指定联系人的身份回复用户的手机消息。保留 contactRef，生成一条联系人的消息，不代替用户发言。',
    commit: 'interaction',
  },
  search: {
    name: 'StorySearch',
    label: '剧情搜索',
    instructions:
      '将查询转成程序检索条件。entityRefs 只使用档案中存在的 ID，terms 为简短关键词，未知日期为 null。日期使用 YYYY-MM-DD。避免加入用户没有指定的过滤条件。',
    commit: 'query',
  },
  persona: {
    name: 'PersonaDraft',
    label: '人设草稿',
    instructions:
      '根据用户要求生成可编辑的人设。保持用户明确提供的内容，force 包含不得代替用户说话、行动或决定的规则。',
    commit: 'draft',
  },
  archiveMetadata: {
    name: 'ArchiveMetadata',
    label: '篇章简介',
    instructions:
      '根据提供的剧情生成准确的篇章名称、简洁简介与关键词。不能把建议或未发生的剧情作为事实。',
    commit: 'draft',
  },
  continuation: {
    name: 'StoryContinuation',
    label: '续写分支',
    instructions:
      '提供3个不同的后续行动选项。每个选项有唯一 id、简洁标题、用户可选择的行动及场景描述。选项尚未发生，不代替用户选择。',
    commit: 'draft',
  },
  rewrite: {
    name: 'NarrativeRewrite',
    label: '局部改写',
    instructions:
      '按用户要求修改指定叙事。返回完整 replacement，未指定的模块保持原样；同步修改实际受影响的翻译、spokenLine、日记和 effects。保持原段落 ID，changedBlockIds 仅列改变的原段落 ID；所有字数、条数和来源约束继续有效。',
    commit: 'draft',
  },
  consistency: {
    name: 'StoryConsistency',
    label: '一致性检查',
    instructions:
      '检查角色、人设、时间、地点、知情范围与前后剧情。每个问题必须引用输入中真实的 messageId/blockId，并列出原文证据和具体建议。没有问题时 issues=[]，不能编造证据。',
    commit: 'query',
  },
  contentImport: {
    name: 'ContentExtraction',
    label: '资料提取',
    instructions:
      '从用户提供的文本或资料 JSON 提取实体、关系、事实和目标。只记录材料明确支持的信息；新实体用 new:名称 引用。所有 sourceBlockId=null；未知日期和期限为 null，无法识别的材料列入 unrecognized。不能创建新剧情。',
    commit: 'draft',
  },
  chapters: {
    name: 'StoryChapters',
    label: '章节整理',
    instructions:
      '将有效剧情整理成按时间排序的章节。每章给出标题、简介和输入中真实的 messageIds，不重复或编造消息 ID，不添加新剧情。',
    commit: 'draft',
  },
  media: {
    name: 'MediaCue',
    label: '配乐与媒体描述',
    instructions:
      '从提供的曲库中推荐一首配乐，trackId 为真实曲目 ID 或 null，说明原因。生成背景图描述和对白语音表演描述；voice.blockId 使用真实段落 ID。这些是描述，不声称图片或音频已经生成。',
    commit: 'draft',
  },
  command: {
    name: 'CommandIntent',
    label: '自然语言操作',
    instructions:
      '理解用户希望进行的本地操作：search搜索、mode切换聊天模式、music选择曲目、archive打开篇章、character打开角色、phone打开联系人、world查看世界。targetId 必须来自上下文中的对应列表，不明确时返回 null 并在 explanation 说明。只有 mode 操作填写 mode，只有 search 填写 query。',
    commit: 'query',
  },
}

export function validateTask<K extends TaskKind>(kind: K, input: unknown): TaskOutput<K> {
  const value = taskSchemas[kind].parse(input) as TaskOutput<K>
  if (kind === 'narrative') return validateNarrative(value) as TaskOutput<K>
  if (kind === 'forum') return validateForum(value) as TaskOutput<K>
  if (kind === 'compression') return validateCompression(value) as TaskOutput<K>
  const issues: string[] = []
  const check = (v: unknown, key = '') => {
    if (
      typeof v === 'string' &&
      !v.trim() &&
      !['prefer', 'gender', 'query', 'translation', 'replyTo'].includes(key)
    )
      issues.push(`${key} 不能为空`)
    else if (Array.isArray(v)) v.forEach((x) => check(x, key))
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => check(x, k))
  }
  check(value)
  if (kind === 'capability') {
    const v = value as TaskOutput<'capability'>
    if (
      !v.ready ||
      v.echo !== 'YanJu strict output' ||
      v.probe.mode !== 'strict' ||
      v.probe.count !== 2 ||
      v.probe.samples.length !== 2 ||
      v.probe.samples[0].label !== 'nested' ||
      v.probe.samples[0].note !== null ||
      !v.probe.samples[0].enabled ||
      v.probe.samples[1].label !== 'array' ||
      v.probe.samples[1].note !== 'ok' ||
      v.probe.samples[1].enabled
    )
      issues.push('渠道结构化测试返回内容不符合测试要求')
  }
  if (kind === 'rewrite') validateNarrative((value as TaskOutput<'rewrite'>).replacement)
  if (kind === 'contentImport')
    issues.push(...validateEffects((value as TaskOutput<'contentImport'>).effects))
  if (kind === 'continuation') {
    const options = (value as TaskOutput<'continuation'>).options
    if (options.length !== 3 || new Set(options.map((o) => o.id)).size !== 3)
      issues.push('须有3个不同的分支选项')
  }
  if (kind === 'chapters' && !(value as TaskOutput<'chapters'>).chapters.length)
    issues.push('至少需要一个章节')
  if (issues.length) throw new ContentValidationError(issues)
  return value
}

const sourceInputSchema = object({ messageId: text, blockId: nullable })
const storedEffect = <S extends z.ZodRawShape>(shape: S) =>
  object({ ...shape, id: text, source: sourceInputSchema })
export const taskInputSchema = object({
  text,
  targetId: nullable,
  context: object({
    archive: object({ id: text, name: text, summary: compressionSchema.optional() }),
    persona: object({
      id: text,
      name: text,
      gender: text,
      identity: text,
      prefer: text,
      force: text,
      createdAt: z.number(),
    }).nullable(),
    story: object({
      entities: z.array(
        storedEffect(
          effectsSchema.shape.entities.element.omit({ ref: true, sourceBlockId: true }).shape,
        ),
      ),
      clock: effectsSchema.shape.clock,
      states: z.array(
        storedEffect(effectsSchema.shape.states.element.omit({ sourceBlockId: true }).shape),
      ),
      relationships: z.array(
        storedEffect(
          effectsSchema.shape.relationships.element.omit({ ref: true, sourceBlockId: true }).shape,
        ),
      ),
      knowledge: z.array(
        storedEffect(
          effectsSchema.shape.knowledge.element.omit({ ref: true, sourceBlockId: true }).shape,
        ),
      ),
      events: z.array(
        storedEffect(
          effectsSchema.shape.events.element.omit({ ref: true, sourceBlockId: true }).shape,
        ),
      ),
      memories: z.array(
        storedEffect(
          effectsSchema.shape.memories.element.omit({ ref: true, sourceBlockId: true }).shape,
        ),
      ),
      goals: z.array(
        storedEffect(
          effectsSchema.shape.goals.element.omit({ ref: true, sourceBlockId: true }).shape,
        ),
      ),
    }),
    target: z.union([narrativeSchema, forumSchema]).nullable(),
    phone: object({
      id: text,
      contactRef: text,
      contact: text,
      messages: z.array(storedEffect({ speaker: text, time: text, text })),
    }).nullable(),
    forum: object({
      id: text,
      source: sourceInputSchema,
      post: forumSchema.shape.post,
      answers: z.array(storedEffect(forumSchema.shape.answers.element.shape)),
    }).nullable(),
    archives: z.array(object({ id: text, name: text })),
    tracks: z.array(object({ id: text, name: text })),
    history: z.array(
      object({
        id: text,
        role: z.enum(['user', 'assistant']),
        text,
        blocks: z.array(object({ id: text, text })),
      }),
    ),
  }),
})
