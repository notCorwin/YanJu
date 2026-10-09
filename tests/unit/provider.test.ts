import { errorDiagnostics } from '../../src/lib/request-trace'
import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  channelFingerprint,
  channelIsReady,
  generateReply,
  testChannel,
  testChannelProtocols,
  friendlyError,
  channelRequest,
  summarize,
} from '../../src/lib/provider'
import { db } from '../../src/lib/storage'
import {
  forumFixture,
  compressionFixture,
  narrativeFixture,
  channelFixture,
  capabilityFixture,
  sse,
  completion,
} from '../fixtures'
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
afterEach(() => vi.useRealTimers())
describe('OpenAI-compatible 严格协议', () => {
  it('模型来自 Models.dev，允许 Base URL 覆盖目录默认地址', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streaming(narrativeFixture))
    await generateReply({
      ...request(fetcher),
      channel: { ...channelFixture, baseUrl: 'https://custom.invalid/v1' },
    })
    expect(String(fetcher.mock.calls[0][0])).toBe('https://custom.invalid/v1/chat/completions')
    await expect(channelRequest({ ...channelFixture, model: 'custom-model' })).rejects.toThrow(
      'Models.dev',
    )
  })
  it('完整能力测试实际运行流式叙事、50 条论坛回答和摘要协议', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const value =
        body.response_format.json_schema.name === 'NarrativeReply'
          ? narrativeFixture
          : body.response_format.json_schema.name === 'ForumReply'
            ? forumFixture
            : body.response_format.json_schema.name === 'CompressionResult'
              ? compressionFixture
              : capabilityFixture
      return body.stream ? streaming(value) : Response.json(completion(value))
    })
    const result = await testChannelProtocols(
      channelFixture,
      new AbortController().signal,
      vi.fn(),
      fetcher,
    )
    expect(result).toMatchObject({ ok: true, protocol: 'chat-completions', protocols: true })
    expect(
      fetcher.mock.calls.map(
        (call) => JSON.parse(String(call[1]?.body)).response_format.json_schema.name,
      ),
    ).toEqual([
      'ChannelCapability',
      'ChannelCapability',
      'NarrativeReply',
      'ForumReply',
      'CompressionResult',
    ])
  })
  it('能力测试拒绝非流式成功但流式协议损坏的渠道', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(completion(capabilityFixture)))
      .mockResolvedValueOnce(streaming({ ready: true }))
    expect(await testChannel(channelFixture, undefined, fetcher)).toMatchObject({
      ok: false,
      checks: { 'chat-completions': { nonStreaming: 'passed', streaming: 'failed' } },
    })
  })
  it('首包和后续内容等待超过一天仍可完成流式回复', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    let stream!: ReadableStreamDefaultController<Uint8Array>
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller
              init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
                once: true,
              })
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    )
    const options = request(fetcher)
    const result = generateReply(options)
    const settled = vi.fn()
    void result.then(settled, settled)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(settled).not.toHaveBeenCalled()
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false)
    const frames = sse(narrativeFixture)
    const encoder = new TextEncoder()
    stream.enqueue(encoder.encode(frames[0]))
    await vi.waitFor(() => expect(options.onPartial).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(86_400_000)
    expect(settled).not.toHaveBeenCalled()
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false)
    for (const frame of frames.slice(1)) stream.enqueue(encoder.encode(frame))
    stream.close()
    await expect(result).resolves.toHaveProperty('reply.value', narrativeFixture)
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it.each([false, true])(
    '长时间等待时仍可手动取消，保留诊断和部分内容（已有内容=%s）',
    async (hasPartial) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const controller = new AbortController()
      let stream!: ReadableStreamDefaultController<Uint8Array>
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        async (_url, init) =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                stream = controller
                init?.signal?.addEventListener(
                  'abort',
                  () => controller.error(init.signal?.reason),
                  {
                    once: true,
                  },
                )
              },
            }),
            { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'waiting-request' } },
          ),
      )
      const options = { ...request(fetcher), signal: controller.signal }
      const result = generateReply(options).then(
        () => undefined,
        (error: unknown) => error,
      )
      const settled = vi.fn()
      void result.then(settled)
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
      if (hasPartial) {
        stream.enqueue(new TextEncoder().encode(sse(narrativeFixture)[0]))
        await vi.waitFor(() => expect(options.onPartial).toHaveBeenCalled())
      }
      await vi.advanceTimersByTimeAsync(86_400_000)
      expect(settled).not.toHaveBeenCalled()
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false)
      controller.abort()
      const failure = await result
      expect(failure).toBeInstanceOf(Error)
      expect(friendlyError(failure)).toContain('已停止生成')
      expect(errorDiagnostics(failure)).toMatchObject({
        requestId: 'waiting-request',
        httpStatus: 200,
        corrections: 0,
        finishReason: 'cancelled',
      })
      const [record] = await db.requests.toArray()
      expect(record.status).toBe('cancelled')
      if (hasPartial) {
        expect(record.partial).toBeDefined()
        expect(record.raw).toBeTruthy()
      }
      expect(fetcher).toHaveBeenCalledOnce()
    },
  )
  it.each([false, true])(
    '非流式请求持续等待，直到返回结果或用户取消（取消=%s）',
    async (cancel) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const controller = new AbortController()
      let respond!: (response: Response) => void
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise((resolve, reject) => {
            respond = resolve
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            })
          }),
      )
      const result = summarize(channelFixture, { messages: [] }, controller.signal, fetcher)
      const settled = vi.fn()
      void result.then(settled, settled)
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(86_400_000)
      expect(settled).not.toHaveBeenCalled()
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false)
      if (cancel) {
        controller.abort()
        await expect(result).rejects.toHaveProperty('name', 'AbortError')
      } else {
        respond(Response.json(completion(compressionFixture)))
        await expect(result).resolves.toEqual(compressionFixture)
      }
      expect(fetcher).toHaveBeenCalledOnce()
    },
  )
  it.each([401, 429])('HTTP %s 失败返回可操作说明和请求编号', async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: { message: 'request rejected', type: 'request_error' } },
          { status, headers: { 'x-request-id': 'rejected-request' } },
        ),
      )
    let failure: unknown
    try {
      await generateReply(request(fetcher))
    } catch (error) {
      failure = error
    }
    expect(errorDiagnostics(failure)).toMatchObject({
      requestId: 'rejected-request',
      httpStatus: status,
    })
    expect(friendlyError(failure)).toMatch(status === 401 ? /授权/ : /受限/)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('能力测试发送 json_schema / strict true，不使用 json_object', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) =>
        JSON.parse(String(init?.body)).stream
          ? streaming(capabilityFixture)
          : Response.json(completion(capabilityFixture)),
      )
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
    expect(body.max_tokens).toBeUndefined()
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
  it('结构化和 JSON mode 都被拒绝时回退到提示词 JSON', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      if (body.response_format)
        return Response.json(
          { error: { message: 'response_format unsupported', type: 'invalid_request_error' } },
          { status: 400 },
        )
      expect(body.messages[0].content).toContain('JSON Schema')
      return streaming(narrativeFixture)
    })
    const result = await generateReply(request(fetcher))
    expect(result.reply.value).toEqual(narrativeFixture)
    expect(result.diagnostics).toMatchObject({ outputMode: 'prompt', fallbacks: 2 })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})
