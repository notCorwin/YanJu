import type { Archive, StoredMessage } from './types'
import type { NarrativeReply, ForumReply } from './schemas'
import { ContentValidationError, validateEffects } from './schemas'
import { countdown, type TurnEffects, type SourceRef } from './domain-schema'

type WithSource<T> = T & { id: string; source: SourceRef }
type Entity = WithSource<Omit<TurnEffects['entities'][number], 'ref' | 'sourceBlockId'>>
export interface StoryState {
  archiveId: string
  revision: number
  entities: Entity[]
  states: WithSource<Omit<TurnEffects['states'][number], 'sourceBlockId'>>[]
  relationships: WithSource<Omit<TurnEffects['relationships'][number], 'ref' | 'sourceBlockId'>>[]
  knowledge: WithSource<Omit<TurnEffects['knowledge'][number], 'ref' | 'sourceBlockId'>>[]
  events: WithSource<Omit<TurnEffects['events'][number], 'ref' | 'sourceBlockId'>>[]
  memories: WithSource<Omit<TurnEffects['memories'][number], 'ref' | 'sourceBlockId'>>[]
  goals: WithSource<Omit<TurnEffects['goals'][number], 'ref' | 'sourceBlockId'>>[]
  clock: TurnEffects['clock']
  phones: {
    id: string
    contactRef: string
    contact: string
    messages: WithSource<{ speaker: string; time: string; text: string }>[]
  }[]
  memos: WithSource<{ text: string; date: string | null; status: 'open' | 'done' }>[]
  purchases: WithSource<NarrativeReply['phone']['purchases'][number] & { date: string | null }>[]
  diaries: WithSource<{ text: string; date: string | null; explanation: string }>[]
  forums: {
    id: string
    source: SourceRef
    post: ForumReply['post']
    answers: WithSource<ForumReply['answers'][number]>[]
  }[]
}
export interface StoryEvent {
  id: string
  archiveId: string
  sequence: number
  source: SourceRef
  effects: TurnEffects
}

const seeds: [string, Entity['kind'], string, string][] = [
  ['character-yanju', 'character', '宴雎', '宴氏董事长'],
  ['character-user', 'character', '沈辞玉', '独立个体，由用户主导言行'],
  ['character-shendu', 'character', '沈渡', '宴雎的人'],
  ['character-father', 'character', '宴父', '荣誉主席'],
  ['character-mother', 'character', '宴母', '宴雎的母亲'],
  ['character-grandfather', 'character', '祖父', '第三代掌舵'],
  ['character-gao', 'character', '高劭良', '政策研究机构，与你有关联'],
  ['location-manor', 'location', '城外庄园', '现居'],
  ['location-old-house', 'location', '老城厢祖宅', '祖宅禁区'],
  ['location-hotel', 'location', '外滩老酒店', '主要场景'],
  ['location-finance', 'location', '江东岸金融区', '主要场景'],
  ['location-tea', 'location', '老城厢茶馆园林', '主要场景'],
  ['location-retreat', 'location', '近郊隐庐', '主要场景'],
  ['organization-yan', 'organization', '宴氏', '宴雎掌管的集团'],
]
export function initialStory(archiveId: string, userName = '沈辞玉'): StoryState {
  return {
    archiveId,
    revision: 0,
    entities: seeds.map(([id, kind, name, description]) => ({
      id,
      kind,
      name: id === 'character-user' ? userName : name,
      description,
      source: { messageId: 'setting', blockId: null },
    })),
    states: [],
    relationships: [],
    knowledge: [],
    events: [],
    memories: [],
    goals: [],
    clock: { dateTime: null, proposalDate: null },
    phones: [],
    memos: [],
    purchases: [],
    diaries: [],
    forums: [],
  }
}
export function entityName(story: StoryState, ref: string) {
  return story.entities.find((e) => e.id === ref)?.name ?? ref
}
const put = <T extends { id: string }>(items: T[], value: T) => {
  const index = items.findIndex((i) => i.id === value.id)
  if (index < 0) items.push(value)
  else items[index] = value
}
const error = (message: string): never => {
  throw new ContentValidationError([message])
}

export function applyEffects(
  story: StoryState,
  effects: TurnEffects,
  message: StoredMessage,
  blockIds?: string[],
) {
  const issues = validateEffects(effects, blockIds)
  if (issues.length) throw new ContentValidationError(issues)
  const refs = new Map(story.entities.map((e) => [e.id, e.id]))
  const source = (blockId: string | null): SourceRef => ({ messageId: message.id, blockId })
  const createId = (ref: string, existing: { id: string }[], kind: string) =>
    ref.startsWith('new:')
      ? `${message.id}:${kind}:${ref.slice(4)}`
      : existing.some((i) => i.id === ref)
        ? ref
        : error(`未知 ${kind} 引用：${ref}；新记录须用 new: 引用`)
  for (const entity of effects.entities) {
    const id = createId(entity.ref, story.entities, 'entity')
    if (refs.has(entity.ref) && story.entities.find((e) => e.id === id)?.kind !== entity.kind)
      error('不能改变实体类型')
    refs.set(entity.ref, id)
    put(story.entities, {
      id,
      kind: entity.kind,
      name: entity.name,
      description: entity.description,
      source: source(entity.sourceBlockId),
    })
  }
  const entity = (ref: string, kind?: Entity['kind']) => {
    const id = refs.get(ref) ?? error(`实体引用不存在：${ref}`)
    if (kind && story.entities.find((e) => e.id === id)?.kind !== kind)
      error(`引用 ${ref} 必须是 ${kind}`)
    return id
  }
  for (const s of effects.states)
    put(story.states, {
      id: `${entity(s.entityRef)}:${s.key}`,
      entityRef: entity(s.entityRef),
      key: s.key,
      value: s.value,
      source: source(s.sourceBlockId),
    })
  for (const r of effects.relationships)
    put(story.relationships, {
      id: createId(r.ref, story.relationships, 'relationship'),
      from: entity(r.from, 'character'),
      to: entity(r.to, 'character'),
      type: r.type,
      description: r.description,
      source: source(r.sourceBlockId),
    })
  for (const k of effects.knowledge)
    put(story.knowledge, {
      id: createId(k.ref, story.knowledge, 'knowledge'),
      entityRef: entity(k.entityRef, 'character'),
      fact: k.fact,
      source: source(k.sourceBlockId),
    })
  for (const e of effects.events)
    put(story.events, {
      id: createId(e.ref, story.events, 'event'),
      title: e.title,
      time: e.time,
      locationRef: e.locationRef === null ? null : entity(e.locationRef, 'location'),
      participants: e.participants.map((p) => entity(p, 'character')),
      description: e.description,
      source: source(e.sourceBlockId),
    })
  for (const m of effects.memories)
    put(story.memories, {
      id: createId(m.ref, story.memories, 'memory'),
      kind: m.kind,
      content: m.content,
      entityRefs: m.entityRefs.map((r) => entity(r)),
      status: m.status,
      source: source(m.sourceBlockId),
    })
  for (const g of effects.goals)
    put(story.goals, {
      id: createId(g.ref, story.goals, 'goal'),
      ownerRef: entity(g.ownerRef, 'character'),
      description: g.description,
      dueDate: g.dueDate,
      status: g.status,
      source: source(g.sourceBlockId),
    })
  if (effects.clock.dateTime !== null) story.clock.dateTime = effects.clock.dateTime
  if (effects.clock.proposalDate !== null) story.clock.proposalDate = effects.clock.proposalDate
  return { resolve: entity, source }
}

export function applyMessage(story: StoryState, message: StoredMessage) {
  if (message.status !== 'complete' || message.stale) return
  const source: SourceRef = { messageId: message.id, blockId: null }
  if (message.reply?.kind === 'narrative') {
    const v = message.reply.value
    const { resolve } = applyEffects(
      story,
      v.effects,
      message,
      v.blocks.map((b) => b.id),
    )
    v.scene.characterRefs.forEach((ref) => resolve(ref, 'character'))
    if (v.scene.locationRef !== null) resolve(v.scene.locationRef, 'location')
    v.blocks.forEach((b) => {
      if (b.speakerRef !== null) resolve(b.speakerRef, 'character')
    })
    for (const [i, text] of v.phone.memos.entries())
      put(story.memos, {
        id: `${message.id}:memo:${i}`,
        text,
        status: 'open',
        date: story.clock.dateTime?.slice(0, 10) ?? null,
        source,
      })
    for (const [i, purchase] of v.phone.purchases.entries())
      put(story.purchases, {
        ...purchase,
        id: `${message.id}:purchase:${i}`,
        date: story.clock.dateTime?.slice(0, 10) ?? null,
        source,
      })
    for (const c of v.phone.conversations) {
      const id = resolve(c.contactRef, 'character')
      let phone = story.phones.find((p) => p.id === id)
      if (!phone) {
        phone = { id, contactRef: id, contact: entityName(story, id), messages: [] }
        story.phones.push(phone)
      }
      for (const [i, m] of c.messages.entries())
        put(phone.messages, { ...m, id: `${message.id}:phone:${id}:${i}`, source })
    }
    put(story.diaries, {
      id: `${message.id}:diary`,
      text: v.diary.text,
      date: story.clock.dateTime?.slice(0, 10) ?? null,
      explanation: v.diary.explanation,
      source,
    })
  } else if (message.reply?.kind === 'forum') {
    const v = message.reply.value
    const id = `${message.id}:post`
    const answers = v.answers.map((a) => ({
      ...a,
      id: `${message.id}:${a.id}`,
      replyTo: a.replyTo ? `${message.id}:${a.replyTo}` : '',
      source,
    }))
    for (const a of v.answers)
      if (a.replyTo && !v.answers.some((candidate) => candidate.id === a.replyTo))
        error(`论坛回复引用不存在：${a.replyTo}`)
    put(story.forums, { id, source, post: { ...v.post, id }, answers })
  } else if (message.interaction?.kind === 'phone') {
    const i = message.interaction
    const phone = story.phones.find((p) => p.id === i.contactRef) ?? error('联系人会话不存在')
    put(phone.messages, {
      id: `${message.id}:user`,
      speaker: message.userName ?? '你',
      time: i.time,
      text: i.userText,
      source,
    })
    put(phone.messages, {
      id: `${message.id}:npc`,
      speaker: i.speaker,
      time: i.time,
      text: i.text,
      source,
    })
  } else if (message.interaction?.kind === 'forum') {
    const i = message.interaction
    const forum = story.forums.find((p) => p.id === i.postId) ?? error('帖子不存在')
    if (i.replyTo !== i.postId && !forum.answers.some((a) => a.id === i.replyTo))
      error('目标回答不存在')
    put(forum.answers, {
      id: `${message.id}:user`,
      author: message.userName ?? '你',
      time: i.time,
      content: i.userText,
      likes: 0,
      replyTo: i.replyTo,
      source,
    })
    put(forum.answers, {
      id: `${message.id}:npc`,
      author: i.author,
      time: i.time,
      content: i.content,
      likes: 0,
      replyTo: `${message.id}:user`,
      source,
    })
  } else if (message.effects) applyEffects(story, message.effects, message)
}

export function rebuildStory(
  archive: Archive,
  messages: StoredMessage[],
): { story: StoryState; events: StoryEvent[] } {
  const story = initialStory(archive.id, archive.userName)
  const events: StoryEvent[] = []
  for (const message of [...messages].sort((a, b) => a.sequence - b.sequence)) {
    applyMessage(story, message)
    const effects =
      message.reply?.kind === 'narrative' ? message.reply.value.effects : message.effects
    if (message.status === 'complete' && !message.stale && effects)
      events.push({
        id: message.id,
        archiveId: archive.id,
        sequence: message.sequence,
        source: { messageId: message.id, blockId: null },
        effects,
      })
  }
  story.revision = archive.revision
  return { story, events }
}
export function displayCountdown(story: StoryState) {
  return countdown(story.clock)
}

export function storyContext(story: StoryState) {
  return {
    entities: story.entities,
    clock: story.clock,
    states: story.states,
    relationships: story.relationships,
    knowledge: story.knowledge,
    memories: story.memories.filter((m) => m.status === 'active'),
    goals: story.goals.filter((g) => g.status === 'open'),
    events: story.events.slice(-12),
  }
}
