import { describe, it, expect, vi } from 'vitest'
import { runStructuredTask } from '../../src/lib/task-runner'
import { testChannel, channelValidationErrors } from '../../src/lib/provider'
import { loadModelCatalog, parseModelCatalog } from '../../src/lib/model-catalog'
import { catalogFixture } from '../model-catalog-fixture'
import { channelFixture, capabilityFixture, narrativeFixture } from '../fixtures'
import { protocolResponse } from '../provider-protocol-fixtures'
import { apiProtocols, type ApiProtocol } from '../../src/lib/types'
import { db, exportSave, normalizeImport } from '../../src/lib/storage'
import { endpointBaseURL } from '../../src/lib/provider-model'
import { effectiveInputLimit } from '../../src/lib/context'

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
  it('手动 Context Window 覆盖旧目录预算，仍预留用户设置的输出容量', () => {
    const channel = {
      ...channelFixture,
      contextWindow: 65536,
      inputLimit: 8192,
      maxOutputTokens: 4096,
      contextWindowOverride: true,
    }
    expect(effectiveInputLimit(channel)).toBe(61440)
    expect(effectiveInputLimit({ ...channel, contextWindowOverride: false })).toBe(8192)
  })

  it('Messages 请求采用明确覆盖的 max_tokens，不被相近模型的旧容量截断', async () => {
    const catalog = fixtureCatalog()
    catalog.mock.models['test-model'].limit.output = 1024
    const channel = {
      ...channelFixture,
      apiMode: 'messages' as const,
      maxOutputTokens: 4096,
      maxOutputTokensOverride: true,
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).max_tokens).toBe(4096)
      return reply('messages', capabilityFixture, false)
    })
    expect(
      (await runStructuredTask({ kind: 'capability', channel, catalog, streaming: false, fetcher }))
        .value,
    ).toEqual(capabilityFixture)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each(supportedProtocols)('自定义 %s 不继承模型目录中的云路由与认证', async (protocol) => {
    const catalog = fixtureCatalog()
    catalog.mock.npm = '@ai-sdk/azure'
    catalog.mock.api = 'https://${AZURE_RESOURCE_NAME}.openai.azure.com/v1'
    catalog.mock.env = ['AZURE_API_KEY', 'AZURE_RESOURCE_NAME']
    catalog.mock.models['test-model'].provider = {
      npm: '@ai-sdk/amazon-bedrock/mantle',
      shape: 'responses',
      api: 'https://${UNRELATED_ACCOUNT}.example/v2',
    }
    const channel = {
      ...channelFixture,
      connectionMode: 'custom' as const,
      providerId: '',
      modelProviderId: 'mock',
      sdk: '@ai-sdk/openai-compatible',
      baseUrl: 'https://custom-gateway.example',
      apiMode: protocol,
      capability: undefined,
    }
    expect(channelValidationErrors(channel)).toEqual({})
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body))
      const headers = new Headers(init?.headers)
      expect(String(url)).toMatch(/^https:\/\/custom-gateway\.example\//)
      expect(String(url)).not.toContain('api-version')
      expect(headers.get('api-key')).toBeNull()
      if (protocol === 'messages') expect(headers.get('x-api-key')).toBe(channel.apiKey)
      else if (['generate-content', 'interactions'].includes(protocol))
        expect(headers.get('x-goog-api-key')).toBe(channel.apiKey)
      else expect(headers.get('authorization')).toBe(`Bearer ${channel.apiKey}`)
      expect(
        body.max_tokens ??
          body.max_output_tokens ??
          body.max_completion_tokens ??
          body.generationConfig?.maxOutputTokens ??
          body.generation_config?.max_output_tokens,
      ).toBe(channel.maxOutputTokens)
      return reply(
        protocol,
        capabilityFixture,
        body.stream === true || String(url).includes('streamGenerateContent'),
      )
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
    }
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('自定义端点必须有地址，不要求选择目录 Provider', () => {
    const channel = {
      ...channelFixture,
      connectionMode: 'custom' as const,
      providerId: '',
      baseUrl: '',
    }
    expect(channelValidationErrors(channel)).toEqual({ baseUrl: '自定义端点需要填写 Base URL。' })
  })

  it('自定义原生兼容 SDK 忽略模型目录的 Responses 覆盖，并在导出导入后保留配置', async () => {
    const catalog = fixtureCatalog()
    catalog.mock.npm = '@ai-sdk/azure'
    catalog.mock.models['test-model'].provider = { shape: 'responses', npm: '@ai-sdk/openai' }
    const channel = {
      ...channelFixture,
      connectionMode: 'custom' as const,
      providerId: '',
      modelProviderId: 'mock',
      sdk: '@ai-sdk/openai-compatible',
      baseUrl: 'https://custom-gateway.example/v1',
      apiMode: 'native' as const,
      capability: undefined,
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(String(url)).toBe(`${channel.baseUrl}/chat/completions`)
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${channel.apiKey}`)
      return reply('chat-completions', capabilityFixture, false)
    })
    expect(
      (await runStructuredTask({ kind: 'capability', channel, catalog, streaming: false, fetcher }))
        .value,
    ).toEqual(capabilityFixture)
    await db.channels.put(channel)
    const saved = normalizeImport(await exportSave())
    expect(saved.channels[0]).toMatchObject({
      connectionMode: 'custom',
      providerId: '',
      modelProviderId: 'mock',
      baseUrl: channel.baseUrl,
      sdk: channel.sdk,
      apiMode: 'native',
    })
  })

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
      expect(
        body.max_tokens ??
          body.max_output_tokens ??
          body.max_completion_tokens ??
          body.generationConfig?.maxOutputTokens ??
          body.generation_config?.max_output_tokens,
      ).toBe(channelFixture.maxOutputTokens)
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
      connectionMode: 'custom' as const,
      providerId: '',
      modelProviderId: 'mock',
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
        contextWindow: 262144,
        inputLimit: 131072,
        maxOutputTokens: 128000,
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

  it.each(supportedProtocols)(
    '从 Google 完整地址自动切换至 %s 时规范化版本与代理前缀',
    (protocol) => {
      const google = ['generate-content', 'interactions', 'google-chat-completions'].includes(
        protocol,
      )
      expect(
        endpointBaseURL('https://gateway.example/proxy/v1beta/openai/chat/completions', protocol),
      ).toBe(
        `https://gateway.example/proxy/${google ? 'v1beta' : 'v1'}${protocol === 'google-chat-completions' ? '/openai' : ''}`,
      )
    },
  )

  it.each([false, true])(
    '持续无效 JSON 在一次本地修复和一次再生成后停止（流式 %s）',
    async (streaming) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => reply('chat-completions', { ready: true }, streaming))
      await expect(
        runStructuredTask({ kind: 'capability', channel: channelFixture, streaming, fetcher }),
      ).rejects.toThrow(/probe/)
      expect(fetcher).toHaveBeenCalledTimes(2)
      const body = JSON.parse(String(fetcher.mock.calls[1][1]?.body))
      expect(body.messages.at(-1).content).toContain('probe')
    },
  )

  it('自动模式遍历全部七类端点，并能从 Google 完整地址发现可用的兼容端点', async () => {
    const calls: string[] = []
    const channel = {
      ...channelFixture,
      connectionMode: 'custom' as const,
      providerId: '',
      apiMode: 'auto' as const,
      baseUrl: 'https://gateway.example/v1beta/models/test-model:generateContent',
      capability: undefined,
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname
      calls.push(path)
      if (path !== '/v1beta/openai/chat/completions')
        return Response.json({ error: { message: 'endpoint not found' } }, { status: 404 })
      return reply(
        'google-chat-completions',
        capabilityFixture,
        JSON.parse(String(init?.body)).stream === true,
      )
    })
    const capability = await testChannel(channel, undefined, fetcher)
    expect(capability).toMatchObject({ ok: true, protocol: 'google-chat-completions' })
    expect(calls).toEqual([
      '/v1/responses',
      '/v1/chat/completions',
      '/v1/completions',
      '/v1/messages',
      '/v1beta/models/test-model:generateContent',
      '/v1beta/interactions',
      '/v1beta/openai/chat/completions',
      '/v1beta/openai/chat/completions',
    ])
  })

  it.each([
    ['@ai-sdk/anthropic', 'messages'],
    ['@ai-sdk/google', 'generate-content'],
    ['@ai-sdk/openai-compatible', 'chat-completions'],
  ] as const)('预置 %s 自动优先探测模型资料对应的 %s', async (sdk, protocol) => {
    const catalog = fixtureCatalog()
    catalog.mock.npm = sdk
    if (protocol === 'chat-completions')
      catalog.mock.models['test-model'].provider = { shape: 'completions' }
    vi.mocked(loadModelCatalog).mockResolvedValueOnce(catalog)
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, init) =>
        reply(
          protocol,
          capabilityFixture,
          JSON.parse(String(init?.body)).stream === true ||
            String(url).includes('streamGenerateContent'),
        ),
      )
    const capability = await testChannel(
      { ...channelFixture, sdk, apiMode: 'auto', capability: undefined },
      undefined,
      fetcher,
    )
    expect(capability).toMatchObject({ ok: true, protocol })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
