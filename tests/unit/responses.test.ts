import { describe, it, expect, vi } from 'vitest'
import {
  generateReply,
  summarize,
  testChannel,
  testChannelProtocols,
  channelFingerprint,
  channelIsReady,
} from '../../src/lib/provider'
import { withCapability } from '../../src/lib/channels'
import { modelMessages } from '../../src/lib/prompts'
import type { ApiProtocol, Channel } from '../../src/lib/types'
import {
  capabilityFixture,
  channelFixture,
  narrativeFixture,
  forumFixture,
  compressionFixture,
  messageFixture,
  completion,
  sse,
  response,
  responseSse,
} from '../fixtures'

const responsesChannel: Channel = { ...channelFixture, apiMode: 'responses' }
const autoChannel: Channel = { ...channelFixture, apiMode: 'auto' }
const streamResponse = (frames: string[]) =>
  new Response(frames.join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
const request = (fetcher: typeof fetch, channel = responsesChannel) => ({
  channel,
  kind: 'narrative' as const,
  instructions: '测试叙事',
  messages: [{ role: 'user' as const, content: '你好' }],
  signal: new AbortController().signal,
  estimatedInput: 13000,
  onPartial: vi.fn(),
  onCorrection: vi.fn(),
  fetcher,
})
function probes(enabled: ApiProtocol[], noStream: ApiProtocol[] = []) {
  return vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const protocol = String(url).endsWith('/responses') ? 'responses' : 'chat-completions'
    const body = JSON.parse(String(init?.body))
    if (!enabled.includes(protocol) || (body.stream && noStream.includes(protocol)))
      return Response.json(
        { error: { message: 'json_schema unsupported', type: 'invalid_request_error' } },
        { status: 400 },
      )
    return protocol === 'responses'
      ? body.stream
        ? streamResponse(responseSse(capabilityFixture))
        : Response.json(response(capabilityFixture))
      : body.stream
        ? streamResponse(sse(capabilityFixture))
        : Response.json(completion(capabilityFixture))
  })
}

describe('自动探测与能力缓存', () => {
  it.each([
    {
      enabled: ['responses', 'chat-completions'] as ApiProtocol[],
      selected: 'responses',
      calls: 4,
    },
    { enabled: ['responses'] as ApiProtocol[], selected: 'responses', calls: 3 },
    { enabled: ['chat-completions'] as ApiProtocol[], selected: 'chat-completions', calls: 3 },
    { enabled: [] as ApiProtocol[], selected: undefined, calls: 2 },
  ])('可用 $enabled 时选择 $selected', async ({ enabled, selected, calls }) => {
    const fetcher = probes(enabled)
    const progress = vi.fn()
    const capability = await testChannel(autoChannel, undefined, fetcher, progress)
    expect(capability.protocol).toBe(selected)
    expect(capability.ok).toBe(selected !== undefined)
    expect(fetcher).toHaveBeenCalledTimes(calls)
    expect(String(fetcher.mock.calls[0][0])).toBe(`${autoChannel.baseUrl}/responses`)
    expect(progress).toHaveBeenCalledTimes(calls)
    expect(channelIsReady({ ...autoChannel, capability })).toBe(selected !== undefined)
    if (!selected) expect(capability.error).toContain('Responses')
  })
  it('非流式成功但流式失败的协议不可选用', async () => {
    const fetcher = probes(['responses', 'chat-completions'], ['responses'])
    const result = await testChannel(autoChannel, undefined, fetcher)
    expect(result.protocol).toBe('chat-completions')
    expect(result.checks?.responses).toMatchObject({ nonStreaming: 'passed', streaming: 'failed' })
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
  it.each(['responses', 'chat-completions'] as const)('手动 %s 只请求选定协议', async (apiMode) => {
    const fetcher = probes(['responses', 'chat-completions'])
    const result = await testChannel({ ...channelFixture, apiMode }, undefined, fetcher)
    expect(result.protocol).toBe(apiMode)
    expect(Object.keys(result.checks!)).toEqual([apiMode])
    expect(fetcher).toHaveBeenCalledTimes(2)
    for (const [, init] of fetcher.mock.calls) {
      const body = JSON.parse(String(init?.body))
      expect(body.max_output_tokens ?? body.max_tokens).toBeUndefined()
    }
  })
  it('取消停止探测，不返回部分成功结果或探测另一个协议', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      controller.abort()
      return Response.json(response(capabilityFixture))
    })
    await expect(testChannel(autoChannel, controller.signal, fetcher)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledOnce()
    const never = vi.fn<typeof fetch>()
    await expect(testChannel(autoChannel, controller.signal, never)).rejects.toThrow()
    expect(never).not.toHaveBeenCalled()
  })
  it('45 秒超时可终止不响应取消的连接', async () => {
    vi.useFakeTimers()
    try {
      const signals: AbortSignal[] = []
      const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
        signals.push(init!.signal!)
        return new Promise(() => {})
      })
      const result = testChannel(responsesChannel, undefined, fetcher)
      await vi.advanceTimersByTimeAsync(45000)
      const capability = await result
      expect(capability.ok).toBe(false)
      expect(capability.error).toContain('45 秒')
      expect(signals[0].aborted).toBe(true)
      expect(fetcher).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
  it('缓存绑定协议和请求配置，改名仍可用，切换实际协议清除校准', async () => {
    const capability = await testChannel(
      autoChannel,
      undefined,
      probes(['responses', 'chat-completions']),
    )
    const tested = { ...autoChannel, capability, calibration: { ratio: 2, samples: 1 } }
    expect(channelIsReady({ ...tested, name: '新名字' })).toBe(true)
    for (const change of [
      { apiMode: 'responses' as const },
      { temperature: null },
      { requestTimeoutMs: 1000 },
      { model: 'changed' },
      { apiKey: 'changed' },
      { baseUrl: 'https://another.test/v1' },
    ])
      expect(channelIsReady({ ...tested, ...change })).toBe(false)
    expect(
      withCapability(tested, { ...capability, protocol: 'chat-completions' }).calibration,
    ).toBeUndefined()
    expect(withCapability(tested, capability).calibration).toEqual(tested.calibration)
    expect(channelFingerprint(tested)).not.toContain(tested.apiKey)
  })
  it('探测后的正式请求固定使用选定协议', async () => {
    const capability = await testChannel(
      autoChannel,
      undefined,
      probes(['responses', 'chat-completions']),
    )
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error: { message: 'Service unavailable' } }, { status: 503 }),
      )
    await expect(generateReply(request(fetcher, { ...autoChannel, capability }))).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(String(fetcher.mock.calls[0][0]).endsWith('/responses')).toBe(true)
  })
})

describe('原生 Responses 结构化业务协议', () => {
  it('完整协议测试使用自动探测选定的 Responses，保留诊断且不依赖旧能力缓存', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body))
      if (String(url).endsWith('/chat/completions'))
        return Response.json({ error: { message: 'unsupported protocol' } }, { status: 400 })
      const value =
        body.text.format.name === 'NarrativeReply'
          ? narrativeFixture
          : body.text.format.name === 'ForumReply'
            ? forumFixture
            : body.text.format.name === 'CompressionResult'
              ? compressionFixture
              : capabilityFixture
      expect(body.store).toBe(false)
      expect(body.text.format.strict).toBe(true)
      return body.stream ? streamResponse(responseSse(value)) : Response.json(response(value))
    })
    const result = await testChannelProtocols(
      autoChannel,
      new AbortController().signal,
      vi.fn(),
      fetcher,
    )
    expect(result).toMatchObject({ ok: true, protocol: 'responses', protocols: true })
    expect(result.firstTokenMs).toBeGreaterThanOrEqual(0)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(fetcher).toHaveBeenCalledTimes(6)
  })
  it.each(['narrative', 'forum'] as const)('%s 流式更新、完整校验和 usage', async (kind) => {
    const value = kind === 'narrative' ? narrativeFixture : forumFixture
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => streamResponse(responseSse(value)))
    const options = {
      ...request(fetcher),
      kind,
      messages: [
        { role: 'system' as const, content: '已覆盖历史的摘要：约好在书房读书' },
        { role: 'assistant' as const, content: JSON.stringify(narrativeFixture) },
        { role: 'user' as const, content: '继续' },
      ],
    }
    const result = await generateReply(options)
    expect(result.reply).toEqual({ kind, value })
    expect(options.onPartial.mock.calls.length).toBeGreaterThan(1)
    expect(result.usage).toMatchObject({ input: 12000, output: 2048, total: 14048 })
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true })
    expect(body.text.format.schema.additionalProperties).toBe(false)
    expect(body.max_output_tokens).toBeUndefined()
    expect(body.store).toBe(false)
    expect(body).not.toHaveProperty('response_format')
    expect(body).not.toHaveProperty('stream_options')
    expect(body).not.toHaveProperty('previous_response_id')
    expect(JSON.stringify(body.input)).toContain('约好在书房读书')
    expect(JSON.stringify(body.input)).toContain('innerVoice')
    expect(JSON.stringify(body.input)).toContain('测试叙事')
  })
  it('摘要使用同一 Responses 协议并验证业务内容', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(response(compressionFixture)))
    expect(
      await summarize(
        responsesChannel,
        { messages: [], targetTokens: 256 },
        new AbortController().signal,
        fetcher,
      ),
    ).toEqual(compressionFixture)
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(body.text.format.name).toBe('CompressionResult')
    expect(body.text.format.strict).toBe(true)
    expect(body.temperature).toBe(0.3)
    expect(body.store).toBe(false)
  })
  it.each(['responses', 'chat-completions'] as const)(
    '模型默认温度在 %s 的测试、回复和摘要中均省略',
    async (apiMode) => {
      const channel = { ...channelFixture, apiMode, temperature: null }
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        expect(body).not.toHaveProperty('temperature')
        const name =
          apiMode === 'responses' ? body.text.format.name : body.response_format.json_schema.name
        const value =
          name === 'ChannelCapability'
            ? capabilityFixture
            : name === 'CompressionResult'
              ? compressionFixture
              : narrativeFixture
        return body.stream
          ? streamResponse(apiMode === 'responses' ? responseSse(value) : sse(value))
          : Response.json(apiMode === 'responses' ? response(value) : completion(value))
      })
      expect((await testChannel(channel, undefined, fetcher)).ok).toBe(true)
      await generateReply(request(fetcher, channel))
      await summarize(
        channel,
        { messages: [], targetTokens: 256 },
        new AbortController().signal,
        fetcher,
      )
      expect(fetcher).toHaveBeenCalledTimes(4)
    },
  )
  it('校验失败仅追加一次相同 schema 的纠正', async () => {
    const broken = { ...narrativeFixture, diary: { ...narrativeFixture.diary, text: '' } }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => streamResponse(responseSse(broken)))
      .mockImplementationOnce(async () => streamResponse(responseSse(narrativeFixture)))
    const options = request(fetcher)
    expect((await generateReply(options)).reply.value).toEqual(narrativeFixture)
    expect(options.onCorrection).toHaveBeenCalledOnce()
    const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies[0].text.format).toEqual(bodies[1].text.format)
    expect(JSON.stringify(bodies[1].input.at(-1))).toContain('校验失败')
  })
  it('纠正请求在摘要续聊和刷新恢复历史中保持完整前缀', async () => {
    const broken = { ...narrativeFixture, diary: { ...narrativeFixture.diary, text: '' } }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => streamResponse(responseSse(broken)))
      .mockImplementation(async () => streamResponse(responseSse(narrativeFixture)))
    const history = [
      messageFixture('covered', 'assistant', '已压缩的历史', 0),
      messageFixture('user', 'user', '继续阅读', 1),
    ]
    const summary = {
      value: compressionFixture,
      coveredThroughId: 'covered',
      coveredCount: 1,
      revision: 1,
      createdAt: 1,
    }
    const options = { ...request(fetcher), messages: modelMessages(history, summary) }
    const result = await generateReply(options)
    const saved = {
      ...messageFixture('reply', 'assistant', '', 2),
      reply: result.reply,
      correction: result.correction,
    }
    await generateReply({
      ...options,
      messages: modelMessages(
        [...history, saved, messageFixture('next', 'user', '接着读', 3)],
        summary,
      ),
    })
    const [initial, corrected, next] = fetcher.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    )
    expect(corrected.input.slice(0, initial.input.length)).toEqual(initial.input)
    expect(result.correction).toBeDefined()
    expect(next.input.slice(0, corrected.input.length)).toEqual(corrected.input)
    expect(next.text.format).toEqual(corrected.text.format)
    expect(JSON.stringify(next.input)).toContain(compressionFixture.summary)
  })
  it.each([
    { terminal: 'incomplete', reason: 'max_output_tokens', message: 'token limit' },
    { terminal: 'incomplete', reason: 'content_filter', message: '拒绝' },
    { terminal: 'missing', reason: undefined, message: '终止事件' },
  ])(
    '$terminal/$reason 即使 JSON 完整也不提交或自动纠正',
    async ({ terminal, reason, message }) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          streamResponse(responseSse(narrativeFixture, terminal, reason)),
        )
      const options = request(fetcher)
      await expect(generateReply(options)).rejects.toThrow(message)
      expect(options.onPartial).toHaveBeenCalled()
      expect(options.onCorrection).not.toHaveBeenCalled()
      expect(fetcher).toHaveBeenCalledOnce()
    },
  )
  it('HTTP 200 中的服务端失败不会被当作完成', async () => {
    const frames = responseSse(narrativeFixture, 'missing')
    frames.push(
      `data: ${JSON.stringify({
        type: 'response.failed',
        sequence_number: 999,
        response: { status: 'failed', error: { code: 'server_error', message: 'upstream failed' } },
      })}\n\n`,
    )
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(frames))
    const options = request(fetcher)
    await expect(generateReply(options)).rejects.toThrow('upstream failed')
    expect(options.onPartial).toHaveBeenCalled()
    expect(options.onCorrection).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('连接异常断开保留已收到的部分对象，明确报错且不纠正', async () => {
    const frames = responseSse(narrativeFixture, 'missing')
    let index = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < frames.length) controller.enqueue(new TextEncoder().encode(frames[index++]))
        else controller.error(new Error('socket reset'))
      },
    })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    const options = request(fetcher)
    await expect(generateReply(options)).rejects.toThrow('连接中断')
    expect(options.onPartial).toHaveBeenCalled()
    expect(options.onCorrection).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it.each([
    { status: 'incomplete', reason: 'max_output_tokens', message: 'token limit' },
    { status: 'failed', reason: undefined, message: '服务端生成失败' },
    { status: 'in_progress', reason: undefined, message: '终止事件' },
  ])('非流式摘要 $status 不提交或自动纠正', async ({ status, reason, message }) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(response(compressionFixture, status, reason)))
    await expect(
      summarize(
        responsesChannel,
        { messages: [], targetTokens: 256 },
        new AbortController().signal,
        fetcher,
      ),
    ).rejects.toThrow(message)
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('非流式摘要 JSON 解析失败只纠正一次，保持 schema', async () => {
    const broken = response(compressionFixture)
    broken.output[0].content[0].text = '{invalid'
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(broken))
      .mockResolvedValueOnce(Response.json(response(compressionFixture)))
    expect(
      await summarize(
        responsesChannel,
        {
          previous: compressionFixture,
          messages: [{ role: 'user', content: '继续记录' }],
          targetTokens: 256,
        },
        new AbortController().signal,
        fetcher,
      ),
    ).toEqual(compressionFixture)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
    expect(bodies[0].text.format).toEqual(bodies[1].text.format)
    expect(JSON.stringify(bodies[1].input)).toContain('校验失败')
    expect(JSON.stringify(bodies[1].input)).toContain(compressionFixture.summary)
  })
  it('流式 refusal 清晰报错且不触发纠正', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        streamResponse([
          `data: ${JSON.stringify({ type: 'response.refusal.done', sequence_number: 1, refusal: 'Cannot generate.' })}\n\n`,
        ]),
      )
    const options = request(fetcher)
    await expect(generateReply(options)).rejects.toThrow('拒绝')
    expect(options.onCorrection).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('非流式 refusal 通过原始错误响应识别', async () => {
    const rejected = {
      ...response(compressionFixture),
      output: [
        {
          type: 'message',
          id: 'msg_mock',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'refusal', refusal: 'Cannot generate.' }],
        },
      ],
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(rejected))
    await expect(
      summarize(
        responsesChannel,
        { messages: [], targetTokens: 256 },
        new AbortController().signal,
        fetcher,
      ),
    ).rejects.toThrow('拒绝')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('停止流式生成不触发纠正', async () => {
    const controller = new AbortController()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(streamResponse(responseSse(narrativeFixture)))
    const options = {
      ...request(fetcher),
      signal: controller.signal,
      onPartial: () => controller.abort(),
    }
    await expect(generateReply(options)).rejects.toThrow()
    expect(options.onCorrection).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('usage 缺失时仍返回完整对象并保留估算机制', async () => {
    const frames = responseSse(narrativeFixture).map((frame) =>
      frame.replace(/,"usage":\{[^}]*\}/g, ''),
    )
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse(frames))
    const result = await generateReply(request(fetcher))
    expect(result.reply.value).toEqual(narrativeFixture)
    expect(result.usage).toBeUndefined()
  })
})
