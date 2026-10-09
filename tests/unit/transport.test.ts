import { catalogFingerprintFixture } from '../fixtures'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as context from '../../src/lib/context'
import { modelMessages } from '../../src/lib/prompts'
import { channelFingerprint } from '../../src/lib/provider'
import { appendMessage, archiveMessages, db } from '../../src/lib/storage'
import { BrowserChatTransport, toChatMessage } from '../../src/lib/transport'
import { captureGameNode, navigateGame, loadGameBranch } from '../../src/lib/game-history'
import { defaults } from '../../src/lib/types'
import {
  channelFixture,
  compressionFixture,
  forumFixture,
  messageFixture,
  narrativeFixture,
} from '../fixtures'

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
    capability: {
      fingerprint: channelFingerprint(channelFixture),
      catalogFingerprint: catalogFingerprintFixture,
      ok: true,
      testedAt: 1,
      protocol: 'chat-completions',
      checks: { 'chat-completions': { nonStreaming: 'passed', streaming: 'passed' } },
    },
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
  it('操作编号被新操作取代时，即使剧情节点未变化也拒绝迟到提交', async () => {
    const archive = (await db.archives.get('archive-1'))!
    await db.transaction('rw', db.gameTables, () => captureGameNode(db, archive, '开局', true))
    const session = (await db.sessions.get(archive.id))!
    mock.generate.mockImplementation(async () => {
      await db.operations.update(archive.id, { owner: 'new-operation' })
      return { reply: { kind: 'narrative', value: narrativeFixture } }
    })
    const chunks = await run()
    expect(await archiveMessages(archive.id)).toHaveLength(5)
    expect(await db.sessions.get(archive.id)).toEqual(session)
    expect((await db.archives.get(archive.id))?.revision).toBe(archive.revision)
    expect(JSON.stringify(chunks)).toContain('会话操作已失效')
  })
  it('生成中回退先取消并保存部分内容，忽略迟到成功结果且原路线仍可恢复', async () => {
    const archive = (await db.archives.get('archive-1'))!
    await db.transaction('rw', db.gameTables, () => captureGameNode(db, archive, '开局', true))
    const session = (await db.sessions.get(archive.id))!
    let received = false
    mock.generate.mockImplementation(async (opts) => {
      opts.onPartial({ scene: { time: '收到的部分剧情' } })
      received = true
      await new Promise<void>((resolve) =>
        opts.signal.addEventListener('abort', () => resolve(), { once: true }),
      )
      // Simulate a provider that delivers a success after the client has cancelled.
      return { reply: { kind: 'narrative', value: narrativeFixture } }
    })
    const running = run()
    await vi.waitFor(() => expect(received).toBe(true))
    await navigateGame(archive.id, session.nodeId, session.branchId)
    await running
    expect(await archiveMessages(archive.id)).toHaveLength(5)
    expect((await db.sessions.get(archive.id))?.nodeId).toBe(session.nodeId)
    expect(await db.nodes.count()).toBe(1)
    await loadGameBranch(archive.id, session.branchId)
    const restored = (await archiveMessages(archive.id)).at(-1)!
    expect(restored.status).toBe('cancelled')
    expect(restored.partial?.value.scene?.time).toBe('收到的部分剧情')
    expect(restored.reply).toBeUndefined()
  })
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
  it('纠正消息随完成回复持久化，下一轮重放已发送的前缀', async () => {
    const correction = '上次回复校验失败，请返回完整日记。'
    mock.generate.mockImplementation(async (opts) => {
      opts.onCorrection('正在纠正', correction)
      return { reply: { kind: 'narrative', value: narrativeFixture }, correction }
    })
    await run()
    const saved = (await archiveMessages('archive-1')).at(-1)!
    expect(saved.correction).toBe(correction)
    const correctedRequest = [
      ...mock.generate.mock.calls[0][0].messages,
      { role: 'user', content: correction },
    ]
    await appendMessage(messageFixture('next-user', 'user', '继续阅读', saved.sequence + 1))
    mock.generate.mockResolvedValueOnce({ reply: { kind: 'narrative', value: narrativeFixture } })
    await run()
    expect(mock.generate.mock.calls[1][0].messages.slice(0, correctedRequest.length)).toEqual(
      correctedRequest,
    )
  })
  it('纠正请求失败仍保留已发送消息，恢复时不把部分回复当成完成历史', async () => {
    const correction = '上次回复校验失败，请重新输出全部模块。'
    mock.generate.mockImplementation(async (opts) => {
      opts.onCorrection('正在纠正', correction)
      opts.onPartial({ scene: { time: '未完成的场景' } })
      throw new Error('第二次请求连接失败')
    })
    await run()
    const history = await archiveMessages('archive-1')
    expect(history.at(-1)?.status).toBe('failed')
    expect(history.at(-1)?.correction).toBe(correction)
    const context = modelMessages(history)
    expect(context.at(-1)).toEqual({ role: 'user', content: correction })
    expect(context.some((m) => String(m.content).includes('未完成的场景'))).toBe(false)
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
    expect((await db.archives.get('archive-1'))?.summary?.value).toEqual(compressionFixture)
    mock.generate.mockResolvedValueOnce({ reply: { kind: 'narrative', value: narrativeFixture } })
    await run('m1')
    const complete = await archiveMessages('archive-1')
    expect(complete).toHaveLength(2)
    expect(complete[0].id).toBe('m0')
    expect(complete[1].reply?.value).toEqual(narrativeFixture)
    const session = (await db.sessions.get('archive-1'))!
    const previous = await db.branches
      .where('archiveId')
      .equals('archive-1')
      .filter((branch) => branch.id !== session.branchId)
      .first()
    expect(previous).toBeDefined()
    const snapshot = (await db.nodes.get(previous!.headId))!
    const versions = await db.messageVersions.bulkGet(snapshot.messageIds)
    expect(versions.slice(0, 5).map((v) => v!.value.content)).toEqual([
      '第一轮输入',
      '第一轮回复',
      '第二轮输入',
      '第二轮回复',
      '当前输入',
    ])
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
  it.each(['narrative', 'forum'] as const)('%s 回复结束前等待最终 OPFS 同步', async (kind) => {
    await db.messages.update('m4', { kind })
    mock.generate.mockResolvedValue({
      reply:
        kind === 'narrative' ? { kind, value: narrativeFixture } : { kind, value: forumFixture },
    })
    let flushed = false
    const flush = vi.spyOn(db.persistence, 'flush').mockImplementation(async () => {
      const saved = (await archiveMessages('archive-1')).at(-1)!
      expect(saved.status).toBe('complete')
      expect(saved.reply?.kind).toBe(kind)
      flushed = true
      return { phase: 'saved', persistent: true }
    })
    const chunks = await run()
    expect(flushed).toBe(true)
    expect(flush).toHaveBeenCalled()
    expect(chunks.find((c) => c.type === 'finish')).toMatchObject({
      messageMetadata: { status: 'complete' },
    })
  })
  it('完成后压缩尚未返回时流已结束，存档可立即读取', async () => {
    vi.spyOn(context, 'contextBudget')
      .mockReturnValueOnce({ estimated: 25000, percent: 0.2, mustCompress: false })
      .mockReturnValueOnce({ estimated: 120000, percent: 0.9, mustCompress: true })
    let resolveCompaction!: () => void
    const pending = new Promise<undefined>((resolve) => {
      resolveCompaction = () => resolve(undefined)
    })
    const compact = vi
      .spyOn(context, 'compactContext')
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(pending)
    mock.generate.mockResolvedValue({ reply: { kind: 'narrative', value: narrativeFixture } })
    const chunks = await run()
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(2))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', messageMetadata: { status: 'complete' } })
    expect((await archiveMessages('archive-1')).at(-1)?.status).toBe('complete')
    resolveCompaction()
    await pending
  })
  it('读档会取消后台摘要请求并等待操作锁释放，保留路线最新回复', async () => {
    const archive = (await db.archives.get('archive-1'))!
    await db.transaction('rw', db.gameTables, () => captureGameNode(db, archive, '开局', true))
    const session = (await db.sessions.get(archive.id))!
    vi.spyOn(context, 'contextBudget')
      .mockReturnValueOnce({ estimated: 25000, percent: 0.2, mustCompress: false })
      .mockReturnValueOnce({ estimated: 120000, percent: 0.9, mustCompress: true })
    let started = false
    let cancelled = false
    vi.spyOn(context, 'compactContext')
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce((options) => {
        started = true
        return new Promise((resolve) => {
          options.signal.addEventListener(
            'abort',
            () => {
              cancelled = true
              resolve(undefined)
            },
            { once: true },
          )
        })
      })
    mock.generate.mockResolvedValue({ reply: { kind: 'narrative', value: narrativeFixture } })
    await run()
    await vi.waitFor(() => expect(started).toBe(true))
    await navigateGame(archive.id, session.nodeId, session.branchId)
    expect(cancelled).toBe(true)
    expect(await archiveMessages(archive.id)).toHaveLength(5)
    await loadGameBranch(archive.id, session.branchId)
    expect((await archiveMessages(archive.id)).at(-1)?.reply?.kind).toBe('narrative')
  })
  it('完成后的压缩失败不会把已保存回复标成失败', async () => {
    vi.spyOn(context, 'contextBudget')
      .mockReturnValueOnce({ estimated: 25000, percent: 0.2, mustCompress: false })
      .mockReturnValueOnce({ estimated: 120000, percent: 0.9, mustCompress: true })
    vi.spyOn(context, 'compactContext')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('后台压缩失败'))
    mock.generate.mockResolvedValue({ reply: { kind: 'narrative', value: narrativeFixture } })
    const chunks = await run()
    await vi.waitFor(async () => {
      expect((await db.archives.get('archive-1'))?.compactionError).toBe('后台压缩失败')
    })
    expect(chunks.find((c) => c.type === 'finish')).toMatchObject({
      messageMetadata: { status: 'complete' },
    })
    expect((await archiveMessages('archive-1')).at(-1)?.status).toBe('complete')
  })
  it('OPFS 同步失败时回复仍完成，保留可导出的记录并说明原因', async () => {
    vi.spyOn(db.persistence, 'flush').mockResolvedValue({
      phase: 'error',
      persistent: false,
      error: '磁盘已满',
    })
    mock.generate.mockResolvedValue({ reply: { kind: 'narrative', value: narrativeFixture } })
    const chunks = await run()
    expect(chunks.find((c) => c.type === 'finish')).toMatchObject({
      messageMetadata: { status: 'complete' },
    })
    expect(
      chunks.find((c) => c.type === 'data-status' && c.data.phase === 'complete'),
    ).toMatchObject({
      data: { detail: expect.stringContaining('OPFS 同步失败') },
    })
    expect((await archiveMessages('archive-1')).at(-1)?.reply?.value).toEqual(narrativeFixture)
  })
  it('并发修改导致最终提交冲突时保留完整收到的内容和另一窗口的修改', async () => {
    mock.generate.mockImplementation(async () => {
      await db.archives.update('archive-1', { revision: 5, name: '另一窗口的篇章' })
      return { reply: { kind: 'narrative', value: narrativeFixture } }
    })
    await run()
    const archive = await db.archives.get('archive-1')
    expect(archive?.name).toBe('另一窗口的篇章')
    expect(archive?.revision).toBe(6)
    expect((await archiveMessages('archive-1')).at(-1)).toMatchObject({
      status: 'failed',
      partial: { kind: 'narrative', value: narrativeFixture },
    })
  })
})
