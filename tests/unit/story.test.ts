import { describe, expect, it } from 'vitest'
import {
  applyMessage,
  initialStory,
  rebuildStory,
  displayCountdown,
  storyContext,
} from '../../src/lib/story'
import { emptyEffects, validDate, validDateTime } from '../../src/lib/domain-schema'
import { validateNarrative, validateEffects } from '../../src/lib/schemas'
import { searchStory } from '../../src/lib/workflows'
import type { Archive, StoredMessage } from '../../src/lib/types'
import { forumFixture, messageFixture, narrativeFixture } from '../fixtures'

const archive: Archive = {
  id: 'archive-1',
  name: '剧情',
  createdAt: 0,
  updatedAt: 0,
  revision: 4,
  draft: '',
}
const first: StoredMessage = {
  ...messageFixture('first', 'assistant', '', 1),
  reply: { kind: 'narrative', value: narrativeFixture },
}
describe('可追踪剧情投影', () => {
  it('临时引用分配稳定 ID，所有关联及事实来源可跨轮重放', () => {
    const { story, events } = rebuildStory(archive, [first])
    expect(story.entities.find((e) => e.name === '书房')?.id).toBe('first:entity:study')
    expect(story.events[0].locationRef).toBe('first:entity:study')
    expect(story.memories[0].source).toEqual({ messageId: 'first', blockId: 'b1' })
    expect(story.goals[0].status).toBe('open')
    expect(events).toHaveLength(1)
    expect(story.revision).toBe(4)
    expect(storyContext(story).memories[0].source).toEqual(story.memories[0].source)
    const next = emptyEffects()
    next.entities = [
      {
        ref: 'first:entity:study',
        kind: 'location',
        name: '书房',
        description: '窗边的书房',
        sourceBlockId: null,
      },
    ]
    next.states = [
      {
        entityRef: 'character-yanju',
        key: story.states[0].key,
        value: '期待明天',
        sourceBlockId: null,
      },
    ]
    next.goals = [
      {
        ref: story.goals[0].id,
        ownerRef: 'character-yanju',
        description: story.goals[0].description,
        dueDate: '2019-06-02',
        status: 'done',
        sourceBlockId: null,
      },
    ]
    applyMessage(story, {
      ...messageFixture('second', 'assistant', '', 2),
      kind: 'material',
      effects: next,
    })
    expect(story.entities.filter((e) => e.id === 'first:entity:study')).toHaveLength(1)
    expect(story.states[0].value).toBe('期待明天')
    expect(story.goals[0].status).toBe('done')
    expect(story.memories[0].content).toBe(narrativeFixture.effects.memories[0].content)
  })
  it('关系和知情范围有稳定引用；非法角色、段落、记录引用被拒绝', () => {
    const state = initialStory(archive.id)
    const effects = emptyEffects()
    effects.relationships = [
      {
        ref: 'new:trusted',
        from: 'character-yanju',
        to: 'character-user',
        type: '信任',
        description: '共同阅读',
        sourceBlockId: null,
      },
    ]
    effects.knowledge = [
      {
        ref: 'new:knows',
        entityRef: 'character-yanju',
        fact: '知道明天的会面安排',
        sourceBlockId: null,
      },
    ]
    applyMessage(state, { ...messageFixture('known', 'assistant', '', 1), effects })
    expect(state.knowledge).toHaveLength(1)
    expect(state.knowledge.some((k) => k.entityRef === 'character-user')).toBe(false)
    expect(state.relationships[0].id).toBe('known:relationship:trusted')
    const invalid = structuredClone(narrativeFixture)
    invalid.effects.states[0].entityRef = 'unknown'
    expect(() =>
      applyMessage(state, { ...first, reply: { kind: 'narrative', value: invalid } }),
    ).toThrow(/不存在/)
    invalid.effects = emptyEffects()
    invalid.scene.locationRef = null
    invalid.effects.memories = [{ ...narrativeFixture.effects.memories[0], ref: 'unknown' }]
    expect(() =>
      applyMessage(state, { ...first, reply: { kind: 'narrative', value: invalid } }),
    ).toThrow(/未知/)
    expect(
      validateEffects(
        {
          ...narrativeFixture.effects,
          states: [{ ...narrativeFixture.effects.states[0], sourceBlockId: 'missing' }],
        },
        ['b1'],
      ),
    ).toContain('来源段落不存在：missing')
  })
  it('日期由程序运算，未知明确为空，跨月闰年及时区按剧情日处理', () => {
    const state = initialStory(archive.id)
    expect(displayCountdown(state)).toBeNull()
    state.clock = { dateTime: '2024-02-28T23:00:00-08:00', proposalDate: '2024-03-01' }
    expect(displayCountdown(state)).toBe(2)
    state.clock.dateTime = '2024-03-02T10:00:00+08:00'
    expect(displayCountdown(state)).toBe(0)
    expect(validDate('2023-02-29')).toBe(false)
    expect(validDateTime('2024-02-29T24:00:00+08:00')).toBe(false)
    expect(validDateTime('2024-02-29T12:00:00+08:00')).toBe(true)
    expect(
      validateEffects({
        ...emptyEffects(),
        clock: { dateTime: '2024-02-30T10:00:00Z', proposalDate: null },
      }).length,
    ).toBeGreaterThan(0)
  })
  it('金额使用最小单位，非法币种与不完整金额不能提交', () => {
    const value = structuredClone(narrativeFixture)
    value.phone.purchases[0].currency = null
    expect(() => validateNarrative(value)).toThrow(/金额/)
    value.phone.purchases[0].currency = '人民币'
    expect(() => validateNarrative(value)).toThrow(/币种/)
    value.phone.purchases[0].currency = 'CNY'
    value.phone.purchases[0].amountMinor = 1.5
    expect(() => validateNarrative(value)).toThrow()
  })
  it('编辑后的失效记录与部分输出不产生事件或状态', () => {
    const { story, events } = rebuildStory(archive, [
      { ...first, stale: true },
      { ...first, id: 'partial', status: 'partial' },
    ])
    expect(story.clock.dateTime).toBeNull()
    expect(story.memories).toHaveLength(0)
    expect(events).toHaveLength(0)
  })
  it('论坛稳定目标与手机会话增量追加，重复重放不产生重复条目', () => {
    const state = initialStory(archive.id)
    applyMessage(state, first)
    applyMessage(state, {
      ...messageFixture('post', 'assistant', '', 2),
      reply: { kind: 'forum', value: forumFixture },
    })
    const append: StoredMessage = {
      ...messageFixture('append', 'assistant', '', 3),
      kind: 'interaction',
      userName: '读者',
      interaction: {
        kind: 'forum',
        postId: 'post:post',
        replyTo: 'post:answer-0',
        author: 'NPC',
        time: '15:00',
        content: '这是回答',
        userText: ' 原文\n第二行 ',
      },
    }
    applyMessage(state, append)
    applyMessage(state, append)
    expect(state.forums[0].answers).toHaveLength(52)
    expect(state.forums[0].answers[50].content).toBe(' 原文\n第二行 ')
    expect(state.forums[0].answers[51].replyTo).toBe('append:user')
    const phone: StoredMessage = {
      ...messageFixture('phone', 'assistant', '', 4),
      kind: 'interaction',
      interaction: {
        kind: 'phone',
        contactRef: 'character-shendu',
        userText: '请确认',
        speaker: '沈渡',
        text: '已确认',
        time: '15:00',
      },
    }
    applyMessage(state, phone)
    applyMessage(state, phone)
    expect(state.phones[0].messages).toHaveLength(6)
    expect(state.phones[0].messages.at(-2)?.text).toBe('请确认')
  })
  it('搜索通过程序执行人物、地点、时间和关键词条件，保留来源', () => {
    const state = rebuildStory(archive, [first]).story
    const query = {
      entityRefs: ['character-yanju'],
      terms: ['阅读'],
      fromDate: '2019-06-01',
      toDate: '2019-06-01',
      category: 'event' as const,
    }
    const hits = searchStory(state, [first], query)
    expect(hits).toHaveLength(1)
    expect(hits[0].source).toEqual({ messageId: 'first', blockId: 'b1' })
    expect(
      searchStory(state, [first], { ...query, fromDate: '2020-01-01', toDate: null }),
    ).toHaveLength(0)
  })
})
