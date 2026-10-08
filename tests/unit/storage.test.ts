import { describe, expect, it } from 'vitest'
import { channelFingerprint, channelIsReady } from '../../src/lib/channels'
import { emptyEffects } from '../../src/lib/domain-schema'
import { modelMessages } from '../../src/lib/prompts'
import {
  appendMessage,
  archiveMessages,
  commitChannelCapability,
  commitSummary,
  db,
  editMessage,
  exportArchive,
  exportSave,
  forkArchive,
  importSave,
  initializeStorage,
  normalizeImport,
  YanJuDatabase,
} from '../../src/lib/storage'
import { defaults, type Archive, type ChannelCapability } from '../../src/lib/types'
import {
  channelFixture,
  compressionFixture,
  forumFixture,
  messageFixture,
  narrativeFixture,
} from '../fixtures'

const archive: Archive = {
  id: 'archive-1',
  name: '篇章',
  createdAt: 1,
  updatedAt: 2,
  revision: 0,
  draft: '',
  userName: '沈辞玉',
}
const save = (messages = [messageFixture('m-0', 'user', '开始阅读', 0)]) => ({
  version: 3,
  exportedAt: new Date().toISOString(),
  archives: [archive],
  messages,
  channels: [channelFixture],
  masks: [],
  settings: defaults,
  storyStates: [],
  storyEvents: [],
  tasks: [],
  requests: [],
})

const testedCapability: ChannelCapability = {
  fingerprint: channelFingerprint(channelFixture),
  testedAt: 2,
  ok: true,
  protocol: 'chat-completions',
  checks: { 'chat-completions': { nonStreaming: 'passed', streaming: 'passed' } },
}
describe('渠道测试结果的并发提交', () => {
  it('事务提交有效结果，保留其他窗口的改名、时间和最新 token 校准', async () => {
    const current = {
      ...channelFixture,
      name: '其他窗口修改的名称',
      createdAt: 123,
      capability: { ...testedCapability, testedAt: 1 },
      calibration: { ratio: 1.3, samples: 4 },
    }
    await db.channels.put(current)
    const saved = await commitChannelCapability(channelFixture, testedCapability)
    expect(saved).toEqual({ ...current, capability: testedCapability })
    expect(await db.channels.get(channelFixture.id)).toEqual(saved)
    expect(channelIsReady(saved!)).toBe(true)
  })
  it.each([true, false])('配置变更后拒绝保存旧探测结果（ok=%s）', async (ok) => {
    const current = {
      ...channelFixture,
      model: '其他窗口的新模型',
      calibration: { ratio: 2, samples: 3 },
    }
    await db.channels.put(current)
    expect(
      await commitChannelCapability(channelFixture, { ...testedCapability, ok }),
    ).toBeUndefined()
    expect(await db.channels.get(current.id)).toEqual(current)
  })
  it('测试期间删除渠道后不重新创建记录', async () => {
    await db.channels.put(channelFixture)
    await db.channels.delete(channelFixture.id)
    expect(await commitChannelCapability(channelFixture, testedCapability)).toBeUndefined()
    expect(await db.channels.count()).toBe(0)
  })
  it('同一配置切换实际协议时仅清除校准并更新能力', async () => {
    const channel = { ...channelFixture, apiMode: 'auto' as const }
    const fingerprint = channelFingerprint(channel)
    await db.channels.put({
      ...channel,
      capability: { ...testedCapability, fingerprint },
      calibration: { ratio: 2, samples: 3 },
    })
    const next: ChannelCapability = {
      ...testedCapability,
      fingerprint,
      protocol: 'responses',
      checks: { responses: { nonStreaming: 'passed', streaming: 'passed' } },
    }
    const saved = await commitChannelCapability(channel, next)
    expect(saved).toEqual({ ...channel, capability: next, calibration: undefined })
    expect(channelIsReady(saved!)).toBe(true)
  })
})
describe('v3 IndexedDB 与独立存档协议', () => {
  it('默认使用新库，不读取旧 localStorage 或旧数据库', async () => {
    expect(db.name).toBe('yanju-v3')
    localStorage.setItem('YanJu_Save', JSON.stringify({ version: 1, archives: [{ id: 'old' }] }))
    const fresh = new YanJuDatabase('v3-fresh-test')
    await initializeStorage(fresh)
    expect(await fresh.archives.count()).toBe(1)
    expect(await fresh.archives.get('old')).toBeUndefined()
    expect((await fresh.messages.toArray())[0].kind).toBe('opening')
    expect(localStorage.getItem('YanJu_Save')).toContain('old')
    await fresh.delete()
  })
  it('明确拒绝 v1、v2，非法导入不改变现有资料', async () => {
    await db.archives.put(archive)
    for (const version of [1, 2])
      await expect(importSave({ ...save(), version })).rejects.toThrow(/版本 3/)
    await expect(importSave({ ...save(), archives: [archive, archive] })).rejects.toThrow(/重复/)
    expect(await db.archives.count()).toBe(1)
    expect(() => normalizeImport({ version: 3 })).toThrow()
  })
  it('完整往返重建事实、来源、投影，并保留请求冻结内容和草稿', async () => {
    const m = {
      ...messageFixture('m-0', 'assistant', '', 0),
      reply: { kind: 'narrative' as const, value: narrativeFixture },
      correction: '请纠正完整回复',
      requestContext: '冻结的事实',
    }
    await importSave({ ...save([m]), archives: [{ ...archive, draft: '未发出的输入' }] })
    const exported = await exportSave()
    expect(exported.version).toBe(3)
    expect(exported.storyStates[0].memories[0].source).toEqual({ messageId: 'm-0', blockId: 'b1' })
    expect(exported.storyEvents[0].effects).toEqual(narrativeFixture.effects)
    expect(exported.channels[0].apiKey).toBe(channelFixture.apiKey)
    expect(exported.channels[0].capability).toBeUndefined()
    expect(exported.messages[0].requestContext).toBe(m.requestContext)
    await importSave(JSON.parse(JSON.stringify(exported)))
    const second = await exportSave()
    expect(second.messages).toEqual(exported.messages)
    expect(second.storyStates).toEqual(exported.storyStates)
    expect(second.storyEvents).toEqual(exported.storyEvents)
    expect(second.settings).toEqual(exported.settings)
    expect(second.archives[0].draft).toBe('未发出的输入')
  })
  it('编辑前文使后续派生剧情失效，保留展示并重建状态', async () => {
    await importSave(
      save([
        messageFixture('m-0', 'user', '原消息', 0),
        {
          ...messageFixture('m-1', 'assistant', '', 1),
          reply: { kind: 'narrative', value: narrativeFixture },
        },
      ]),
    )
    await commitSummary(archive.id, 0, {
      value: compressionFixture,
      coveredThroughId: 'm-1',
      coveredCount: 2,
      revision: 0,
      createdAt: 1,
    })
    await appendMessage(messageFixture('m-2', 'user', '新的消息', 2))
    expect((await db.archives.get(archive.id))?.summary?.revision).toBe(1)
    await editMessage('m-2', '修改未覆盖消息')
    expect((await db.archives.get(archive.id))?.summary).toBeDefined()
    await editMessage('m-0', '修改已覆盖消息')
    const history = await archiveMessages(archive.id)
    expect(history).toHaveLength(3)
    expect(history[1].stale).toBe(true)
    expect(history[1].reply).toBeDefined()
    expect((await db.archives.get(archive.id))?.summary).toBeUndefined()
    expect((await db.storyStates.get(archive.id))?.memories).toHaveLength(0)
    expect(await db.storyEvents.count()).toBe(0)
    expect(modelMessages(history)).toHaveLength(1)
  })
  it('完整回复与状态在单次事务中提交，错误引用回滚全部写入', async () => {
    await importSave(save())
    const invalid = structuredClone(narrativeFixture)
    invalid.effects.states[0].entityRef = 'missing'
    await expect(
      appendMessage(
        {
          ...messageFixture('m-1', 'assistant', '', 1),
          reply: { kind: 'narrative', value: invalid },
        },
        0,
      ),
    ).rejects.toThrow(/不存在/)
    expect(await db.messages.count()).toBe(1)
    expect((await db.archives.get(archive.id))?.revision).toBe(0)
    expect((await db.storyStates.get(archive.id))?.states).toHaveLength(0)
  })
  it('重复提交幂等，多窗口版本与序号冲突拒绝覆盖', async () => {
    await db.archives.put(archive)
    const message = messageFixture('m-0', 'user', '阅读', 0)
    await appendMessage(message)
    await appendMessage(message)
    expect((await db.archives.get(archive.id))?.revision).toBe(1)
    expect(await db.messages.count()).toBe(1)
    await expect(appendMessage(messageFixture('another', 'user', '冲突', 0))).rejects.toThrow(
      /序号/,
    )
    await expect(appendMessage(messageFixture('m-1', 'user', '新消息', 1), 0)).rejects.toThrow(
      /窗口/,
    )
    await expect(
      commitSummary(archive.id, 0, {
        value: compressionFixture,
        coveredThroughId: 'm',
        coveredCount: 1,
        revision: 0,
        createdAt: 1,
      }),
    ).rejects.toThrow(/变更/)
  })
})

describe('v3 分支与合并引用', () => {
  it.each(['fork', 'merge'] as const)(
    '%s 重映射跨轮实体、关系、会话与事实来源，并保留用户原文',
    async (mode) => {
      const first = structuredClone(narrativeFixture)
      first.effects.entities.push({
        ref: 'new:guest',
        kind: 'character',
        name: '来客',
        description: '新朋友',
        sourceBlockId: 'b1',
      })
      const second = structuredClone(narrativeFixture)
      second.scene.locationRef = 'm1:entity:study'
      second.effects = {
        ...emptyEffects(),
        states: [{ entityRef: 'm1:entity:guest', key: '心情', value: '开心', sourceBlockId: 'b1' }],
        relationships: [
          {
            ref: 'new:friend',
            from: 'm1:entity:guest',
            to: 'character-yanju',
            type: '朋友',
            description: '共同读书',
            sourceBlockId: 'b1',
          },
        ],
        events: [
          {
            ref: 'new:visit',
            title: '来访',
            time: null,
            locationRef: 'm1:entity:study',
            participants: ['m1:entity:guest'],
            description: '朋友到访',
            sourceBlockId: 'b1',
          },
        ],
      }
      second.phone.conversations[0].contactRef = 'm1:entity:guest'
      const messages = [
        {
          ...messageFixture('m1', 'assistant', JSON.stringify(first), 0),
          reply: { kind: 'narrative' as const, value: first },
        },
        {
          ...messageFixture('m2', 'assistant', JSON.stringify(second), 1),
          reply: { kind: 'narrative' as const, value: second },
          requestContext: JSON.stringify({
            source: { messageId: 'm1', blockId: 'b1' },
            entities: [{ id: 'm1:entity:guest', name: 'm1' }],
          }),
        },
        {
          ...messageFixture('m3', 'assistant', JSON.stringify(forumFixture), 2),
          kind: 'forum' as const,
          reply: { kind: 'forum' as const, value: forumFixture },
        },
        {
          ...messageFixture('m4', 'assistant', '用户 m1:entity:guest 原文', 3),
          kind: 'interaction' as const,
          interaction: {
            kind: 'forum' as const,
            postId: 'm3:post',
            replyTo: 'm3:answer-0',
            userText: '用户 m1:entity:guest 原文',
            author: '读者',
            time: '15:00',
            content: '回答',
          },
        },
      ]
      await importSave(save(messages))
      const original = await exportArchive(archive.id)
      const newId =
        mode === 'fork'
          ? (await forkArchive(archive.id, 'm4')).id
          : (await importSave(original, db, false, 'merge')).archives[0].id
      const copied = await archiveMessages(newId)
      const projected = (await db.storyStates.get(newId))!
      const guest = projected.entities.find((entity) => entity.name === '来客')!
      expect(guest.id).toBe(`${copied[0].id}:entity:guest`)
      expect(projected.states.find((state) => state.entityRef === guest.id)?.value).toBe('开心')
      expect(projected.relationships[0].from).toBe(guest.id)
      expect(projected.events.at(-1)?.participants).toContain(guest.id)
      expect(projected.phones.some((phone) => phone.contactRef === guest.id)).toBe(true)
      expect(projected.forums[0].answers.at(-2)?.replyTo).toBe(`${copied[2].id}:answer-0`)
      expect(copied[3].interaction?.userText).toBe('用户 m1:entity:guest 原文')
      expect(JSON.parse(copied[1].requestContext!)).toEqual({
        source: { messageId: copied[0].id, blockId: 'b1' },
        entities: [{ id: guest.id, name: 'm1' }],
      })
      expect((await exportArchive(archive.id)).messages).toEqual(original.messages)
      await expect(importSave(await exportSave())).resolves.toBeDefined()
    },
  )
  it.each([
    { usage: {} },
    { diagnostics: { elapsedMs: 1 } },
    { createdAt: 9_000_000_000_000_000 },
    { sequence: -1 },
  ])('损坏的 v3 元数据拒绝覆盖：%j', async (invalid) => {
    await db.archives.put(archive)
    await expect(
      importSave(save([{ ...messageFixture('invalid', 'user', '原文', 0), ...invalid } as never])),
    ).rejects.toThrow()
    expect(await db.archives.get(archive.id)).toEqual(archive)
  })
})
