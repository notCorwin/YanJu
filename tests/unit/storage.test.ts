import { describe, it, expect } from 'vitest'
import {
  appendMessage,
  archiveMessages,
  commitSummary,
  commitChannelCapability,
  db,
  editMessage,
  exportSave,
  importSave,
  normalizeImport,
} from '../../src/lib/db'
import { convertLegacy } from '../../src/lib/legacy'
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
describe('IndexedDB 与存档迁移', () => {
  it('v2 渠道协议和模型默认温度往返保留，导入清除能力缓存', async () => {
    await importSave({
      version: 2,
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
    expect(exported.version).toBe(2)
    expect(exported.channels[0]).toMatchObject({ apiMode: 'responses', temperature: null })
    expect(exported.channels[0].capability).toBeUndefined()
    await importSave(JSON.parse(JSON.stringify(exported)))
    expect((await exportSave()).channels).toEqual(exported.channels)
    expect(() =>
      normalizeImport({ version: 2, channels: [{ ...channelFixture, apiMode: 'unknown' }] }),
    ).toThrow('API 模式')
    expect(() =>
      normalizeImport({ version: 2, channels: [{ ...channelFixture, apiMode: ['responses'] }] }),
    ).toThrow('API 模式')
  })
  it('v1 保留消息、渠道、人设、时间与外观，升级为 v2', async () => {
    const v1 = {
      version: 1,
      archives: [
        {
          id: archive.id,
          name: '旧存档',
          createdAt: 1,
          updatedAt: 2,
          messages: [
            {
              id: 'old-msg',
              role: 'assistant',
              content: '纯文本',
              rawContent:
                '<div class="censy-lux-header"><div class="censy-meta-val">2019年</div><div class="censy-meta-val">书房</div><div class="censy-meta-val">宴雎</div></div><p>旧正文</p><div class="lux_wrap"><details><div class="lux_lab">STATE / INTERNAL</div><div class="lux_sec"><div class="lux_h">心声</div><div class="lux_ph">旧心声</div></div></details><details><div class="lux_lab">ARCHIVE / PROTOCOL</div><div>短中长记忆</div></details></div><script>window.legacyExecuted=true</script>',
              timestamp: 123,
            },
          ],
        },
      ],
      channels: [
        {
          ...channelFixture,
          maxTokens: 2048,
          maxOutputTokens: undefined,
          contextWindow: undefined,
        },
      ],
      masks: [
        {
          id: 'mask',
          name: '旧人设',
          gender: '其他',
          identity: '读者',
          prefer: '阅读',
          force: '不要替我说话',
          createdAt: 3,
        },
      ],
      settings: {
        fontChat: 18,
        fontUi: 14,
        fontFamily: 'KaiTi',
        bgImage: 'data:image/png;base64,test',
        bgOpacity: 25,
      },
    }
    const result = await importSave(v1)
    expect(result.channels[0].maxOutputTokens).toBe(2048)
    expect(result.channels[0].contextWindow).toBe(32768)
    expect(result.messages[0].createdAt).toBe(123)
    expect(result.messages[0].legacy?.panels).toHaveLength(1)
    expect(result.messages[0].legacy?.scene?.location).toBe('书房')
    expect(result.messages[0].legacy?.body).toContain('旧正文')
    expect(result.messages[0].legacy?.body).not.toContain('legacyExecuted')
    const exported = await exportSave()
    expect(exported.version).toBe(2)
    expect(exported.channels[0].apiKey).toBe(channelFixture.apiKey)
    expect(exported.settings.bgOpacity).toBe(25)
    expect(exported.masks[0].force).toBe(v1.masks[0].force)
    await importSave(JSON.parse(JSON.stringify(exported)))
    expect((await exportSave()).messages).toEqual(exported.messages)
    expect((await exportSave()).settings).toEqual(exported.settings)
  })
  it('旧论坛 XML 转换为帖子与全部回答', () => {
    const xml = `<zf><g5>旧标题</g5><g6>旧时间</g6><g7>旧帖子正文</g7>${Array.from({ length: 50 }, (_, i) => `<r>${i}|作者${i}|今天|回答${i}|${i}|回复</r>`).join('')}</zf>`
    const converted = convertLegacy(xml)
    expect(converted.forum?.post.title).toBe('旧标题')
    expect(converted.forum?.answers).toHaveLength(50)
  })
  it('非法导入在修改数据库前失败', async () => {
    await db.archives.put(archive)
    await expect(
      importSave({ version: 2, archives: [archive, archive], messages: [] }),
    ).rejects.toThrow(/重复/)
    expect(await db.archives.count()).toBe(1)
    expect(() => normalizeImport({ version: 3 })).toThrow()
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
  it('v2 保留严格对象、恢复数据、草稿与边界', async () => {
    const m = {
      ...messageFixture('m-0', 'assistant', '', 0),
      reply: { kind: 'narrative' as const, value: narrativeFixture },
      correction: '上次校验失败，请输出完整回复。',
    }
    await importSave({
      version: 2,
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
