import { describe, it, expect, vi } from 'vitest'
import { runStructuredTask } from '../../src/lib/task-runner'
import { testChannel } from '../../src/lib/provider'
import { parseModelCatalog } from '../../src/lib/model-catalog'
import { catalogFixture } from '../model-catalog-fixture'
import { channelFixture, capabilityFixture, narrativeFixture } from '../fixtures'
import { protocolResponse } from '../provider-protocol-fixtures'
import { apiProtocols, type ApiProtocol } from '../../src/lib/types'
import { db, exportSave, normalizeImport } from '../../src/lib/storage'
import { endpointBaseURL } from '../../src/lib/provider-model'

const reply = (protocol: ApiProtocol, value: unknown, streaming: boolean) => {
  const r = protocolResponse(protocol, value, streaming)
  return new Response(r.body, { headers: { 'content-type': r.contentType } })
}
const json = JSON.stringify(capabilityFixture)
const fixtureCatalog = () => {
  const source = catalogFixture()
  Object.assign(source.mock.models['test-model'].limit, { output: 128000 })
  return parseModelCatalog(source)
}
const supportedProtocols = apiProtocols.filter((p) => p !== 'native')

describe('所有端点共用的 JSON 生成流程', () => {
  it.each(supportedProtocols)('%s 同时验证非流式与流式，省略可选输出上限', async (protocol) => {
    const channel = { ...channelFixture, apiMode: protocol }
    const catalog = fixtureCatalog()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      const streaming = body.stream === true || String(_input).includes('streamGenerateContent')
      return reply(protocol, capabilityFixture, streaming)
    })
    for (const streaming of [false, true]) {
      const result = await runStructuredTask({
        kind: 'capability',
        channel,
        catalog,
        streaming,
        fetcher,
      })
      expect(result.value).toEqual(capabilityFixture)
      expect(result.diagnostics.outputMode).toBe('structured')
    }
    expect(fetcher).toHaveBeenCalledTimes(2)
    const urls = fetcher.mock.calls.map(([url]) => String(url))
    const suffix = {
      'chat-completions': '/v1/chat/completions',
      completions: '/v1/completions',
      responses: '/v1/responses',
      messages: '/v1/messages',
      'generate-content': '/v1beta/models/test-model:generateContent',
      interactions: '/v1beta/interactions',
      'google-chat-completions': '/v1beta/openai/chat/completions',
    }[protocol]
    expect(urls[0]).toBe(`https://mock.example${suffix}`)
    for (const [, init] of fetcher.mock.calls) {
      const body = JSON.parse(String(init?.body))
      expect(body.max_tokens).toBe(protocol === 'messages' ? 128000 : undefined)
      expect(
        body.max_output_tokens ??
          body.max_completion_tokens ??
          body.generationConfig?.maxOutputTokens ??
          body.generation_config?.max_output_tokens,
      ).toBeUndefined()
    }
  })

  it.each([false, true])(
    'Structured Outputs 失败后 JSON mode 成功（流式 %s）',
    async (streaming) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        if (body.response_format.type === 'json_schema')
          return Response.json(
            { error: { message: 'json_schema not supported by this model' } },
            { status: 400 },
          )
        expect(body.response_format).toEqual({ type: 'json_object' })
        expect(body.messages[0].content).toContain('required')
        return reply('chat-completions', capabilityFixture, streaming)
      })
      const result = await runStructuredTask({
        kind: 'capability',
        channel: channelFixture,
        streaming,
        fetcher,
      })
      expect(result.diagnostics).toMatchObject({ outputMode: 'json', fallbacks: 1, corrections: 0 })
      expect(fetcher).toHaveBeenCalledTimes(2)
    },
  )

  it.each(supportedProtocols)(
    '%s 在两种传输中依次回退到提示词 JSON，仍进行本地校验',
    async (protocol) => {
      for (const streaming of [false, true]) {
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
          const body = JSON.parse(String(init?.body))
          const format =
            body.response_format ??
            body.text?.format ??
            body.output_config?.format ??
            body.generationConfig?.responseMimeType
          if (format)
            return Response.json(
              { error: { message: 'JSON response_format schema unsupported' } },
              { status: 400 },
            )
          return reply(protocol, capabilityFixture, streaming)
        })
        const result = await runStructuredTask({
          kind: 'capability',
          channel: { ...channelFixture, apiMode: protocol },
          catalog: fixtureCatalog(),
          streaming,
          fetcher,
        })
        expect(result.value).toEqual(capabilityFixture)
        expect(result.diagnostics).toMatchObject({
          outputMode: 'prompt',
          fallbacks: 2,
          corrections: 0,
        })
        const records = (await db.requests.toArray()).sort((a, b) => a.attempt - b.attempt)
        expect(records.map((r) => r.request.outputMode)).toEqual(['structured', 'json', 'prompt'])
        expect(records[2].request.instructions).toContain('所有 required 字段都必须填写')
        await db.requests.clear()
      }
    },
  )

  it.each([
    ['@ai-sdk/openai', 'responses', '/v1/responses'],
    ['@ai-sdk/anthropic', 'messages', '/v1/messages'],
    ['@ai-sdk/google', 'generate-content', '/v1beta/models/test-model:generateContent'],
  ] as const)('原生 %s 同样接受完整端点 Base URL', async (sdk, protocol, path) => {
    const catalog = fixtureCatalog()
    catalog.mock.npm = sdk
    const channel = {
      ...channelFixture,
      sdk,
      apiMode: 'native' as const,
      baseUrl: `https://override.example${path}`,
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(reply(protocol, capabilityFixture, false))
    const result = await runStructuredTask({
      kind: 'capability',
      catalog,
      channel,
      streaming: false,
      fetcher,
    })
    expect(result.value).toEqual(capabilityFixture)
    expect(String(fetcher.mock.calls[0][0])).toBe(`https://override.example${path}`)
  })

  it('没有 Structured Outputs 标记的模型仍可测试并使用 JSON mode', async () => {
    const catalog = fixtureCatalog()
    catalog.mock.models['test-model'].structured_output = false
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body.response_format.type).toBe('json_object')
      return reply('chat-completions', capabilityFixture, body.stream === true)
    })
    const result = await runStructuredTask({
      kind: 'capability',
      catalog,
      channel: channelFixture,
      fetcher,
    })
    expect(result.diagnostics.outputMode).toBe('json')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each(['api-key', 'sigv4'])(
    'Anthropic AWS 使用 %s 认证和目录完整容量，SDK 不支持的 JSON mode 在签名后不改写请求',
    async (auth) => {
      const catalog = fixtureCatalog()
      catalog.mock.npm = '@ai-sdk/anthropic-aws'
      const channel = {
        ...channelFixture,
        sdk: '@ai-sdk/anthropic-aws',
        apiMode: 'native' as const,
        apiKey: JSON.stringify({
          workspaceId: 'workspace-test',
          ...(auth === 'api-key'
            ? { apiKey: 'test-key' }
            : { AWS_ACCESS_KEY_ID: 'test-access', AWS_SECRET_ACCESS_KEY: 'test-secret' }),
        }),
      }
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        expect(body.max_tokens).toBe(128000)
        const headers = new Headers(init?.headers)
        expect(headers.get('anthropic-workspace-id')).toBe('workspace-test')
        if (auth === 'api-key') expect(headers.get('x-api-key')).toBe('test-key')
        else expect(headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /)
        if (body.output_config)
          return Response.json(
            { error: { message: 'JSON schema output_config unsupported' } },
            { status: 400 },
          )
        return reply('messages', capabilityFixture, false)
      })
      const result = await runStructuredTask({
        kind: 'capability',
        catalog,
        channel,
        streaming: false,
        fetcher,
      })
      expect(result.value).toEqual(capabilityFixture)
      expect(result.diagnostics).toMatchObject({ outputMode: 'prompt', fallbacks: 2 })
      expect(fetcher).toHaveBeenCalledTimes(2)
    },
  )

  it.each([
    '@ai-sdk/deepseek',
    '@ai-sdk/alibaba',
    '@ai-sdk/gmicloud',
    '@ai-sdk/moonshotai',
    '@ai-sdk/zai',
  ])('原生 %s 自动选择 JSON mode 时补充完整 Schema，不重复调用模型', async (sdk) => {
    const catalog = fixtureCatalog()
    catalog.mock.npm = sdk
    const channel = { ...channelFixture, sdk, apiMode: 'native' as const }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body.response_format).toEqual({ type: 'json_object' })
      expect(
        body.messages.map((message: { content: string }) => message.content).join('\n'),
      ).toContain('JSON Schema')
      return reply('chat-completions', capabilityFixture, body.stream === true)
    })
    const result = await runStructuredTask({ kind: 'capability', catalog, channel, fetcher })
    expect(result.diagnostics).toMatchObject({ outputMode: 'json', fallbacks: 1 })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each([false, true])('语法损坏先本地修复，不额外请求（流式 %s）', async (streaming) => {
    const raw = `\`\`\`json\n${json.replace('"ready":true', '"ready":True').replace(/}$/, ',}')}\n\`\`\``
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => reply('chat-completions', raw, streaming))
    const result = await runStructuredTask({
      kind: 'capability',
      channel: channelFixture,
      streaming,
      fetcher,
    })
    expect(result.value).toEqual(capabilityFixture)
    expect(result.diagnostics).toMatchObject({ repairs: 1, corrections: 0 })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('本地补充可空未知字段，但不能伪造缺失的正文模块', async () => {
    const raw = structuredClone(capabilityFixture)
    delete (raw.probe.samples[0] as Partial<(typeof raw.probe.samples)[number]>).note
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => reply('chat-completions', raw, false))
    const result = await runStructuredTask({
      kind: 'capability',
      channel: channelFixture,
      streaming: false,
      fetcher,
    })
    expect(result.value.probe.samples[0].note).toBeNull()
    expect(result.diagnostics.repairs).toBe(1)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('缺失必填正文时附加字段路径重新生成，维持同一输出模式', async () => {
    const broken = structuredClone(narrativeFixture) as Partial<typeof narrativeFixture>
    delete broken.diary
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(reply('chat-completions', broken, true))
      .mockResolvedValueOnce(reply('chat-completions', narrativeFixture, true))
    const result = await runStructuredTask({ kind: 'narrative', channel: channelFixture, fetcher })
    expect(result.value).toEqual(narrativeFixture)
    expect(result.diagnostics.corrections).toBe(1)
    const body = JSON.parse(String(fetcher.mock.calls[1][1]?.body))
    expect(body.messages.at(-1).content).toMatch(/diary.*不要遗漏/)
    expect(body.response_format.type).toBe('json_schema')
  })

  it.each([401, 403, 429, 500])('HTTP %s 不进行格式降级或内容重试', async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ error: { message: 'json_schema request rejected' } }, { status }),
      )
    await expect(
      runStructuredTask({ kind: 'capability', channel: channelFixture, fetcher }),
    ).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('流式和非流式可记录不同的回退模式并完成存档往返', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      if (body.stream && body.response_format?.type === 'json_schema')
        return Response.json(
          { error: { message: 'streaming json_schema unsupported' } },
          { status: 400 },
        )
      return reply('chat-completions', capabilityFixture, body.stream === true)
    })
    const capability = await testChannel(channelFixture, undefined, fetcher)
    expect(capability).toMatchObject({
      ok: true,
      checks: { 'chat-completions': { outputMode: 'structured', streamingOutputMode: 'json' } },
    })
    await db.channels.put({ ...channelFixture, capability })
    const save = await exportSave()
    expect(normalizeImport(save, true).channels[0].capability).toEqual(capability)
    const records = await db.requests.toArray()
    expect(records.map((r) => r.request.outputMode).sort()).toEqual([
      'json',
      'structured',
      'structured',
    ])
    expect(normalizeImport(save, true).requests).toHaveLength(3)
  })

  it('端点地址接受 origin、前缀或完整路径，保留已有版本与代理前缀', () => {
    expect(endpointBaseURL('https://example.com', 'messages')).toBe('https://example.com/v1')
    expect(endpointBaseURL('https://example.com/proxy/v1/responses', 'responses')).toBe(
      'https://example.com/proxy/v1',
    )
    expect(
      endpointBaseURL(
        'https://example.com/v1beta/openai/chat/completions',
        'google-chat-completions',
      ),
    ).toBe('https://example.com/v1beta/openai')
    expect(
      endpointBaseURL('https://example.com/v1beta/models/a:generateContent', 'interactions'),
    ).toBe('https://example.com/v1beta')
  })
})
