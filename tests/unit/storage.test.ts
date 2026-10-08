import { describe, it, expect } from 'vitest'
import {
  appendMessage,
  archiveMessages,
  commitSummary,
  db,
  editMessage,
  exportSave,
  importSave,
  normalizeImport,
  YanJuDatabase,
  initializeStorage,
} from '../../src/lib/db'
import { defaults, type Archive } from '../../src/lib/types'
import { modelMessages } from '../../src/lib/prompts'
import { channelFixture, compressionFixture, messageFixture, narrativeFixture } from '../fixtures'

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
