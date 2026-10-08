import { describe, it, expect, vi } from 'vitest'
import { calibrate, compactContext, contextBudget, shouldCompact } from '../../src/lib/context'
import { modelMessages } from '../../src/lib/prompts'
import type { Archive, Channel } from '../../src/lib/types'
import { channelFingerprint } from '../../src/lib/channels'
import { channelFixture, compressionFixture, messageFixture } from '../fixtures'

const archive: Archive = {
  id: 'archive-1',
  name: '篇章',
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
  draft: '',
}
const messages = Array.from({ length: 20 }, (_, i) =>
  messageFixture(`m-${i}`, i % 2 ? 'assistant' : 'user', '阅读安排'.repeat(2000), i),
)
describe('上下文预算与压缩事务', () => {
  it('Responses 预算按选定协议计入完整历史、摘要和 schema', () => {
    const history = messages.slice(0, 4)
    const summary = {
      value: compressionFixture,
      coveredThroughId: 'm-1',
      coveredCount: 2,
      revision: 1,
      createdAt: 1,
    }
    const channel: Channel = { ...channelFixture, apiMode: 'auto' }
    const ready: Channel = {
      ...channel,
      capability: {
        fingerprint: channelFingerprint(channel),
        testedAt: 1,
        ok: true,
        protocol: 'responses',
        checks: { responses: { nonStreaming: 'passed', streaming: 'passed' } },
      },
    }
    const budget = contextBudget(ready, undefined, 'narrative', history, summary)
    expect(budget.estimated).toBe(
      contextBudget(
        { ...channelFixture, apiMode: 'responses' },
        undefined,
        'narrative',
        history,
        summary,
      ).estimated,
    )
    expect(budget.estimated).toBeGreaterThan(
      contextBudget(ready, undefined, 'narrative', [], undefined).estimated,
    )
    expect(modelMessages(history, summary)[0].content).toContain(compressionFixture.summary)
  })
  it('85% 精确边界与输出预留', () => {
    expect(shouldCompact(8499, 10000, 1000)).toBe(false)
    expect(shouldCompact(8500, 10000, 1000)).toBe(true)
    expect(shouldCompact(7000, 10000, 4000)).toBe(true)
    expect(shouldCompact(7000, 10000, 3000)).toBe(false)
  })
  it('预算计入角色、人设、schema、历史和摘要', () => {
    const channel = { ...channelFixture, contextWindow: 32768 }
    const opening = messageFixture('opening', 'assistant', '开场白'.repeat(300), 0)
    const user = messageFixture('user', 'user', '你好', 1)
    const initial = contextBudget(channel, undefined, 'narrative', [opening, user])
    expect(initial.estimated).toBeGreaterThan(20000)
    expect(initial.estimated + channel.maxOutputTokens).toBeLessThan(channel.contextWindow)
    const withPersona = contextBudget(
      channel,
      {
        id: 'p',
        name: '测试',
        gender: '',
        identity: '',
        prefer: '喜好'.repeat(500),
        force: '',
        createdAt: 1,
      },
      'narrative',
      [opening, user],
    )
    expect(withPersona.estimated).toBeGreaterThan(initial.estimated)
  })
  it('usage 校正包含保守余量', () => {
    const c = calibrate(channelFixture, 20000, 10000)!
    expect(c.ratio).toBeCloseTo(2.24)
    expect(c.samples).toBe(1)
  })
  it.each(['responses', 'chat-completions'] as const)(
    '%s 分批压缩大量历史，最后一次性提交，并至少保留最新一轮',
    async (apiMode) => {
      const commit = vi.fn()
      const summarize = vi.fn().mockResolvedValue(compressionFixture)
      const channel = { ...channelFixture, apiMode, contextWindow: 65536 }
      const summary = await compactContext({
        archive,
        channel,
        kind: 'narrative',
        messages,
        signal: new AbortController().signal,
        summarize,
        commit,
      })
      expect(summarize.mock.calls.length).toBeGreaterThan(1)
      expect(commit).toHaveBeenCalledOnce()
      expect(summary?.coveredCount).toBeLessThanOrEqual(messages.length - 2)
      expect(
        contextBudget(channel, undefined, 'narrative', messages, summary).percent,
      ).toBeLessThanOrEqual(0.7)
      expect(messages).toHaveLength(20)
      expect(modelMessages(messages, summary).at(-1)?.content).toBe(messages.at(-1)?.content)
    },
  )
  it('中间一批失败或取消，原摘要和原文保持不变', async () => {
    const old = {
      value: compressionFixture,
      coveredThroughId: 'm-1',
      coveredCount: 2,
      revision: 1,
      createdAt: 1,
    }
    const current = { ...archive, summary: old }
    const snapshot = JSON.stringify(current)
    const commit = vi.fn()
    const summarize = vi
      .fn()
      .mockResolvedValueOnce(compressionFixture)
      .mockRejectedValueOnce(new Error('第二批失败'))
    await expect(
      compactContext({
        archive: current,
        channel: { ...channelFixture, contextWindow: 65536 },
        kind: 'narrative',
        messages,
        signal: new AbortController().signal,
        summarize,
        commit,
      }),
    ).rejects.toThrow('第二批失败')
    expect(commit).not.toHaveBeenCalled()
    expect(JSON.stringify(current)).toBe(snapshot)
    const controller = new AbortController()
    await expect(
      compactContext({
        archive: current,
        channel: { ...channelFixture, contextWindow: 65536 },
        kind: 'narrative',
        messages,
        signal: controller.signal,
        summarize: async () => {
          controller.abort()
          return compressionFixture
        },
        commit,
      }),
    ).rejects.toThrow()
    expect(commit).not.toHaveBeenCalled()
  })
  it('失效摘要从原文重建', async () => {
    const summarize = vi.fn().mockResolvedValue(compressionFixture)
    await compactContext({
      archive: {
        ...archive,
        summary: {
          value: compressionFixture,
          coveredThroughId: 'm-1',
          coveredCount: 2,
          revision: 0,
          createdAt: 1,
        },
      },
      channel: { ...channelFixture, contextWindow: 65536 },
      kind: 'narrative',
      messages,
      signal: new AbortController().signal,
      summarize,
      commit: vi.fn(),
    })
    expect(summarize.mock.calls[0][0].previous).toBeUndefined()
    expect(summarize.mock.calls[0][0].messages[0].content).toBe(messages[0].content)
  })
  it('固定设定和最新输入超容量时，不删历史或提交不合格摘要', async () => {
    const commit = vi.fn()
    await expect(
      compactContext({
        archive,
        channel: { ...channelFixture, contextWindow: 4096 },
        kind: 'narrative',
        messages: messages.slice(-2),
        signal: new AbortController().signal,
        summarize: vi.fn(),
        commit,
      }),
    ).rejects.toThrow(/容量|上下文|预算/)
    expect(commit).not.toHaveBeenCalled()
  })
})
