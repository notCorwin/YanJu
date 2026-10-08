import { describe, it, expect, vi, beforeEach } from 'vitest'
import { db, archiveMessages } from '../../src/lib/db'
import { defaults } from '../../src/lib/types'
import { channelFingerprint } from '../../src/lib/provider'
import { BrowserChatTransport, toChatMessage } from '../../src/lib/transport'
import { channelFixture, compressionFixture, messageFixture, narrativeFixture } from '../fixtures'

const mock = vi.hoisted(() => ({ generate: vi.fn(), summarize: vi.fn() }))
vi.mock('../../src/lib/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/provider')>()),
  generateReply: mock.generate,
  summarize: mock.summarize,
}))

async function run(regenerateFromId?: string, signal = new AbortController().signal) {
  const all = await archiveMessages('archive-1')
  const stream = await new BrowserChatTransport().sendMessages({
    chatId: 'archive-1',
    trigger: regenerateFromId ? 'regenerate-message' : 'submit-message',
    messageId: regenerateFromId,
    messages: all.map(toChatMessage),
    abortSignal: signal,
    body: { regenerateFromId },
  })
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}
beforeEach(async () => {
  mock.generate.mockReset()
  mock.summarize.mockReset()
  await db.settings.put({
    ...defaults,
    activeArchiveId: 'archive-1',
    activeChannelId: channelFixture.id,
  })
  await db.channels.put({
    ...channelFixture,
    capability: { fingerprint: channelFingerprint(channelFixture), ok: true, testedAt: 1 },
  })
  await db.archives.put({
    id: 'archive-1',
    name: '篇章',
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    draft: '',
  })
  await db.messages.bulkPut([
    messageFixture('m0', 'user', '第一轮输入', 0),
    messageFixture('m1', 'assistant', '第一轮回复', 1),
    messageFixture('m2', 'user', '第二轮输入', 2),
    messageFixture('m3', 'assistant', '第二轮回复', 3),
    messageFixture('m4', 'user', '当前输入', 4),
  ])
})
describe('浏览器 ChatTransport 与持久化', () => {
  it('类型化 partial 部件更新，完整校验结果才标记完成', async () => {
    mock.generate.mockImplementation(async (opts) => {
      opts.onPartial({ scene: { time: '2019年' } })
      opts.onPartial(narrativeFixture)
      return { reply: { kind: 'narrative', value: narrativeFixture } }
    })
    const chunks = await run()
    const parts = chunks.filter((c) => c.type === 'data-narrative')
    expect(parts.length).toBeGreaterThanOrEqual(2)
    expect(parts.every((c) => 'id' in c && c.id === 'reply')).toBe(true)
    const saved = (await archiveMessages('archive-1')).at(-1)!
    expect(saved.status).toBe('complete')
    expect(saved.reply?.value).toEqual(narrativeFixture)
  })
  it('取消保留收到的部分对象，重新载入仍可恢复', async () => {
    const controller = new AbortController()
    mock.generate.mockImplementation(async (opts) => {
      opts.onPartial({ scene: { time: '2019年' } })
      controller.abort()
      throw new DOMException('Cancelled', 'AbortError')
    })
    await run(undefined, controller.signal)
    const saved = (await archiveMessages('archive-1')).at(-1)!
    expect(saved.status).toBe('cancelled')
    expect(saved.partial?.value.scene?.time).toBe('2019年')
    expect(saved.reply).toBeUndefined()
    expect(toChatMessage(saved).parts[0].type).toBe('data-narrative')
  })
  it('重说失败保留原分支，成功后原子替换分支，并使已覆盖摘要失效', async () => {
    await db.archives.update('archive-1', {
      summary: {
        value: compressionFixture,
        coveredThroughId: 'm3',
        coveredCount: 4,
        revision: 1,
        createdAt: 1,
      },
    })
    mock.generate.mockRejectedValueOnce(new Error('连接失败'))
    await run('m1')
    const failed = await archiveMessages('archive-1')
    expect(failed.slice(0, 5).map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
    expect(failed.at(-1)?.status).toBe('failed')
    expect((await db.archives.get('archive-1'))?.summary).toBeUndefined()
    mock.generate.mockResolvedValueOnce({ reply: { kind: 'narrative', value: narrativeFixture } })
    await run('m1')
    const complete = await archiveMessages('archive-1')
    expect(complete).toHaveLength(2)
    expect(complete[0].id).toBe('m0')
    expect(complete[1].reply?.value).toEqual(narrativeFixture)
  })
  it('请求开始时冻结渠道，切换设置不会把结果写入另一存档', async () => {
    await db.archives.put({
      id: 'other',
      name: '另一个篇章',
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      draft: '',
    })
    mock.generate.mockImplementation(async (opts) => {
      expect(opts.channel.id).toBe(channelFixture.id)
      await db.settings.update('app', {
        activeArchiveId: 'other',
        activeChannelId: 'different-channel',
      })
      return { reply: { kind: 'narrative', value: narrativeFixture } }
    })
    await run()
    expect(await archiveMessages('other')).toHaveLength(0)
    expect((await archiveMessages('archive-1')).at(-1)?.reply).toBeDefined()
  })
})
