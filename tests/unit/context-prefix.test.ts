import { describe, expect, it, vi } from 'vitest'
import { buildInstructions, modelMessages } from '../../src/lib/prompts'
import { generateReply } from '../../src/lib/provider'
import type { StoredMessage, Summary } from '../../src/lib/types'
import type { RequestKind } from '../../src/lib/schemas'
import {
  channelFixture,
  compressionFixture,
  forumFixture,
  messageFixture,
  narrativeFixture,
  sse,
} from '../fixtures'

const streaming = (value: unknown) =>
  new Response(sse(value).join(''), { headers: { 'content-type': 'text/event-stream' } })
const request = (
  fetcher: typeof fetch,
  messages: StoredMessage[],
  kind: RequestKind = 'narrative',
  summary?: Summary,
) => ({
  channel: channelFixture,
  kind,
  instructions: buildInstructions(undefined, kind),
  messages: modelMessages(messages, summary),
  signal: new AbortController().signal,
  estimatedInput: 13000,
  onPartial: vi.fn(),
  onCorrection: vi.fn(),
  fetcher,
})
const user = messageFixture('u1', 'user', '一起读书。', 0)
const assistant: StoredMessage = {
  ...messageFixture('a1', 'assistant', '', 1),
  reply: { kind: 'narrative', value: narrativeFixture },
}
const nextUser = messageFixture('u2', 'user', '接着读。', 2)
const bodyOf = (call: Parameters<typeof fetch>) => JSON.parse(String(call[1]?.body))

describe('LLM 请求前缀与压缩后续聊', () => {
  it('普通连续对话保留 SDK 实际发出的原消息前缀和 schema', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => streaming(narrativeFixture))
    await generateReply(request(fetcher, [user]))
    await generateReply(request(fetcher, [user, assistant, nextUser]))
    const [before, after] = fetcher.mock.calls.map(bodyOf)
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages)
    expect(after.response_format).toEqual(before.response_format)
  })

  it.each(['narrative', 'forum'] as const)(
    '%s 压缩摘要可通过真实 SDK，后续消息只追加',
    async (kind) => {
      const value = kind === 'narrative' ? narrativeFixture : forumFixture
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => streaming(value))
      const summary: Summary = {
        value: compressionFixture,
        coveredThroughId: assistant.id,
        coveredCount: 2,
        revision: 1,
        createdAt: 1,
      }
      const history = [user, assistant, nextUser]
      const result = await generateReply(request(fetcher, history, kind, summary))
      const saved: StoredMessage = {
        ...messageFixture('a2', 'assistant', '', 3),
        reply: result.reply,
      }
      await generateReply(
        request(
          fetcher,
          [...history, saved, messageFixture('u3', 'user', '明天也一起读书。', 4)],
          kind,
          summary,
        ),
      )
      const [before, after] = fetcher.mock.calls.map(bodyOf)
      expect(result.reply.value).toEqual(value)
      expect(before.messages[0].role).toBe('system')
      expect(before.messages[1]).toEqual({
        role: 'system',
        content: `已覆盖历史的摘要（作为事实背景，继续尊重用户人设）：\n${JSON.stringify(compressionFixture)}`,
      })
      expect(before.messages[2]).toEqual({ role: 'user', content: nextUser.content })
      expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages)
      expect(after.response_format).toEqual(before.response_format)
    },
  )

  it('纠正成功后的下一轮保留纠正请求的完整前缀', async () => {
    const broken = { ...narrativeFixture, diary: { ...narrativeFixture.diary, text: '' } }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(streaming(broken))
      .mockResolvedValueOnce(streaming(narrativeFixture))
      .mockResolvedValueOnce(streaming(narrativeFixture))
    const result = await generateReply(request(fetcher, [user]))
    const saved = { ...assistant, reply: result.reply, correction: result.correction }
    await generateReply(request(fetcher, [user, saved, nextUser]))
    const [initial, corrected, next] = fetcher.mock.calls.map(bodyOf)
    expect(corrected.messages.slice(0, initial.messages.length)).toEqual(initial.messages)
    expect(result.correction).toBe(corrected.messages.at(-1).content)
    expect(next.messages.slice(0, corrected.messages.length)).toEqual(corrected.messages)
    expect(next.response_format).toEqual(corrected.response_format)
  })
})
