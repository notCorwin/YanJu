import Dexie from 'dexie'
import { toChatMessage } from '../../src/lib/transport'
import { modelMessages } from '../../src/lib/prompts'
import { describe, it, expect } from 'vitest'
import {
  appendMessage,
  createArchive,
  initializeStorage,
  YanJuDatabase,
  archiveMessages,
  commitSummary,
  commitChannelCapability,
  db,
  editMessage,
  exportSave,
  importSave,
  normalizeImport,
} from '../../src/lib/storage'
import { defaults, type Archive, type ChannelCapability } from '../../src/lib/types'
import { channelFingerprint, channelIsReady } from '../../src/lib/channels'
import { channelFixture, compressionFixture, messageFixture, narrativeFixture } from '../fixtures'

const archive: Archive = {
  id: 'archive-1',
  name: '篇章',
  createdAt: 1,
  updatedAt: 2,
  revision: 0,
  draft: '',
}
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
describe('IndexedDB 与原生 v3 存档', () => {
  it('v3 渠道协议和模型默认温度往返保留，导入清除能力缓存', async () => {
    await importSave({
      version: 3,
      archives: [],
      messages: [],
      masks: [],
      channels: [
        {
          ...channelFixture,
          apiMode: 'responses',
          temperature: null,
          capability: { ok: true, protocol: 'responses', fingerprint: 'untrusted', testedAt: 1 },
        },
      ],
    })
    const exported = await exportSave()
    expect(exported.version).toBe(3)
    expect(exported.channels[0]).toMatchObject({ apiMode: 'responses', temperature: null })
    expect(exported.channels[0].capability).toBeUndefined()
    await importSave(JSON.parse(JSON.stringify(exported)))
    expect((await exportSave()).channels).toEqual(exported.channels)
    expect(() =>
      normalizeImport({ version: 3, channels: [{ ...channelFixture, apiMode: 'unknown' }] }),
    ).toThrow('API 模式')
    expect(() =>
      normalizeImport({ version: 3, channels: [{ ...channelFixture, apiMode: ['responses'] }] }),
    ).toThrow('API 模式')
  })
  it.each([1, 2])('拒绝版本 %s，现有消息、渠道和设置不受影响', async (version) => {
    await db.archives.put(archive)
    await db.messages.put(messageFixture('retained', 'user', '当前消息', 0))
    await db.channels.put(channelFixture)
    await db.settings.put(defaults)
    const before = await exportSave()
    await expect(
      importSave({ version, archives: [], messages: [], channels: [], masks: [] }),
    ).rejects.toThrow('仅支持版本 3')
    const after = await exportSave()
    expect({ ...after, exportedAt: before.exportedAt }).toEqual(before)
  })
  it('开场白为原生文本，编辑后保留时间并可直接进入模型上下文', async () => {
    const created = await createArchive()
    const [opening] = await archiveMessages(created.id)
    expect(opening.kind).toBe('text')
    expect(opening.content.length).toBeGreaterThan(0)
    await editMessage(opening.id, '新的开场白')
    const [edited] = await archiveMessages(created.id)
    expect(edited).toMatchObject({
      kind: 'text',
      content: '新的开场白',
      createdAt: opening.createdAt,
    })
    expect(toChatMessage(edited).parts).toEqual([{ type: 'text', text: '新的开场白' }])
    expect(modelMessages([edited])).toEqual([{ role: 'assistant', content: '新的开场白' }])
    await importSave(JSON.parse(JSON.stringify(await exportSave())))
    expect(await archiveMessages(created.id)).toEqual([edited])
  })
  it('新启动忽略旧 localStorage 和数据库，并保留旧数据', async () => {
    const previous = new Dexie('yanju-v2')
    previous.version(2).stores({ archives: 'id' })
    const fresh = new YanJuDatabase('test-native-startup')
    try {
      await previous.table('archives').put({ id: 'old-archive', name: '旧数据库' })
      localStorage.setItem(
        'yanju_archives',
        JSON.stringify([{ id: 'old-local', name: '旧本地资料' }]),
      )
      await initializeStorage(fresh)
      expect(new YanJuDatabase().name).toBe('yanju-v3')
      expect((await fresh.archives.toArray()).map((a) => a.name)).toEqual(['新的篇章'])
      expect((await fresh.messages.toArray())[0].kind).toBe('text')
      expect(await previous.table('archives').get('old-archive')).toEqual({
        id: 'old-archive',
        name: '旧数据库',
      })
      expect(localStorage.getItem('yanju_archives')).toContain('old-local')
    } finally {
      await fresh.delete()
      await previous.delete()
    }
  })
  it('非法导入在修改数据库前失败', async () => {
    await db.archives.put(archive)
    await expect(
      importSave({ version: 3, archives: [archive, archive], messages: [] }),
    ).rejects.toThrow(/重复/)
    expect(await db.archives.count()).toBe(1)
    expect(() => normalizeImport({ version: 4 })).toThrow()
  })
  it('追加保留覆盖边界，编辑已覆盖消息使摘要失效', async () => {
    await db.archives.put(archive)
    await db.messages.bulkPut([
      messageFixture('m-0', 'user', '原消息', 0),
      messageFixture('m-1', 'assistant', '原回复', 1),
    ])
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
    expect((await db.archives.get(archive.id))?.summary).toBeUndefined()
    expect(await archiveMessages(archive.id)).toHaveLength(3)
  })
  it('压缩并发版本冲突拒绝提交，原摘要保持', async () => {
    await db.archives.put({ ...archive, revision: 1 })
    await expect(
      commitSummary(archive.id, 0, {
        value: compressionFixture,
        coveredThroughId: 'm',
        coveredCount: 1,
        revision: 0,
        createdAt: 1,
      }),
    ).rejects.toThrow(/变更/)
    expect((await db.archives.get(archive.id))?.summary).toBeUndefined()
  })
  it('v3 保留严格对象、恢复数据、草稿与边界', async () => {
    const m = {
      ...messageFixture('m-0', 'assistant', '', 0),
      reply: { kind: 'narrative' as const, value: narrativeFixture },
      correction: '上次校验失败，请输出完整回复。',
    }
    await importSave({
      version: 3,
      archives: [{ ...archive, draft: '未发出的输入' }],
      messages: [m],
      channels: [channelFixture],
      masks: [],
      settings: defaults,
    })
    const data = await exportSave()
    expect(data.messages[0].reply).toEqual(m.reply)
    expect(data.messages[0].correction).toBe(m.correction)
    expect(data.archives[0].draft).toBe('未发出的输入')
    expect(data.channels[0].capability).toBeUndefined()
  })
})
