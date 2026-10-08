import { describe, it, expect } from 'vitest'
import {
  appendMessage,
  archiveMessages,
  commitSummary,
  db,
  editMessage,
  exportSave,
  importSave,
  initializeStorage,
  normalizeImport,
} from '../../src/lib/db'
import { convertLegacy } from '../../src/lib/legacy'
import { defaults, type Archive } from '../../src/lib/types'
import { channelFixture, compressionFixture, messageFixture, narrativeFixture } from '../fixtures'

const archive: Archive = {
  id: 'archive-1',
  name: '篇章',
  createdAt: 1,
  updatedAt: 2,
  revision: 0,
  draft: '',
}
describe('OPFS 存档与 IndexedDB 配置', () => {
  it('重复启动保留存档和草稿，仅将未完成回复标记为可恢复', async () => {
    await initializeStorage()
    const saved = (await db.settings.get('app'))!
    const archive = (await db.archives.toArray())[0]
    await initializeStorage()
    expect((await db.settings.get('app'))?.archiveCatalogId).toBe(saved.archiveCatalogId)
    expect(await db.archives.count()).toBe(1)
    expect(await db.personas.count()).toBe(1)
    await db.archives.update(archive.id, { draft: '保留草稿' })
    await db.messages.put({
      ...messageFixture('partial', 'assistant', '收到的内容', 1),
      archiveId: archive.id,
      status: 'partial',
    })
    await initializeStorage()
    expect((await db.archives.get(archive.id))?.draft).toBe('保留草稿')
    expect(await db.messages.get('partial')).toMatchObject({
      content: '收到的内容',
      status: 'cancelled',
    })
  })
  it('仅接受 v2 JSON，不再转换旧版存档', () => {
    expect(() => normalizeImport({ version: 1 })).toThrow(/版本 2/)
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
    expect(data.archives[0].draft).toBe('未发出的输入')
    expect(data.channels[0].capability).toBeUndefined()
  })
})
