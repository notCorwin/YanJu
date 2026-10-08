import { describe, it, expect, vi } from 'vitest'
import {
  channelFingerprint,
  channelIsReady,
  generateReply,
  testChannel,
} from '../../src/lib/provider'
import { narrativeFixture, channelFixture, capabilityFixture, sse } from '../fixtures'
import type { DeepPartial } from 'ai'
import type { NarrativeReply } from '../../src/lib/schemas'

const request = (fetcher: typeof fetch, onPartial = vi.fn()) => ({
  channel: channelFixture,
  kind: 'narrative' as const,
  instructions: '测试叙事',
  messages: [{ role: 'user' as const, content: '你好' }],
  signal: new AbortController().signal,
  estimatedInput: 13000,
  onPartial,
  onCorrection: vi.fn(),
  fetcher,
})
function streaming(value: unknown, finishReason = 'stop'): Response {
  return new Response(sse(value, finishReason).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}
describe('OpenAI-compatible 严格协议', () => {
  it('能力测试发送 json_schema / strict true，不使用 json_object', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streaming(capabilityFixture))
    const capability = await testChannel(channelFixture, undefined, fetcher)
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(body.response_format.type).toBe('json_schema')
    expect(body.response_format.json_schema.strict).toBe(true)
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false)
    expect(channelIsReady({ ...channelFixture, capability })).toBe(true)
    expect(channelIsReady({ ...channelFixture, model: 'changed', capability })).toBe(false)
    expect(channelFingerprint(channelFixture)).not.toContain(channelFixture.apiKey)
  })
  it('部分对象持续更新，并在完整校验后返回 usage', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streaming(narrativeFixture))
    const parts: DeepPartial<NarrativeReply>[] = []
    const result = await generateReply(
      request(fetcher, (p: DeepPartial<NarrativeReply>) => parts.push(p)),
    )
    expect(parts.length).toBeGreaterThan(1)
    expect(parts[0].diary).toBeUndefined()
    expect(result.reply).toEqual({ kind: 'narrative', value: narrativeFixture })
    expect(result.usage?.input).toBe(12000)
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(body.stream_options.include_usage).toBe(true)
    expect(body.max_tokens).toBe(channelFixture.maxOutputTokens)
  })
  it('非空校验失败只追加一次同 schema 纠正', async () => {
    const broken = { ...narrativeFixture, diary: { ...narrativeFixture.diary, text: '' } }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(streaming(broken))
      .mockResolvedValueOnce(streaming(narrativeFixture))
    const options = request(fetcher)
    expect((await generateReply(options)).reply.value).toEqual(narrativeFixture)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(options.onCorrection).toHaveBeenCalledOnce()
    const bodies = fetcher.mock.calls.map((c) => JSON.parse(String(c[1]?.body)))
    expect(bodies[0].response_format).toEqual(bodies[1].response_format)
    expect(bodies[1].messages.at(-1).content).toContain('校验失败')
  })
  it('缺字段校验失败允许一次纠正，重复失败结束', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => streaming({ scene: narrativeFixture.scene }))
    await expect(generateReply(request(fetcher))).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('截断保留 partial，明确报错且不自动重复请求', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(streaming({ scene: narrativeFixture.scene }, 'length'))
    const options = request(fetcher)
    await expect(generateReply(options)).rejects.toThrow(/truncated/)
    expect(options.onPartial).toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('取消不会触发纠正请求', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streaming(narrativeFixture))
    const options = {
      ...request(fetcher),
      signal: controller.signal,
      onPartial: () => controller.abort(),
    }
    await expect(generateReply(options)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('不支持结构化的渠道直接拒绝，不降级请求', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: {
            message: 'response_format json_schema unsupported',
            type: 'invalid_request_error',
          },
        },
        { status: 400 },
      ),
    )
    await expect(generateReply(request(fetcher))).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
