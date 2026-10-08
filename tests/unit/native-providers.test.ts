import { describe, expect, it, vi } from 'vitest'
import { generateText, streamText, Output } from 'ai'
import { z } from 'zod'
import {
  createProviderModel,
  credentialApiKey,
  resolveCatalogApi,
} from '../../src/lib/provider-model'
import { parseModelCatalog } from '../../src/lib/model-catalog'
import { completion, response, responseSse, sse } from '../fixtures'

const schema = z.object({ ready: z.boolean() })
const value = { ready: true }
const makeCatalog = (sdk: string, id: string) =>
  parseModelCatalog({
    test: {
      id: 'test',
      name: 'Native test',
      npm: sdk,
      env: ['TEST_API_KEY'],
      models: {
        [id]: {
          id,
          name: id,
          structured_output: true,
          temperature: true,
          modalities: { input: ['text'], output: ['text'] },
          limit: { context: 1000000, output: 128000 },
        },
      },
    },
  })

describe('原生 SDK 与浏览器连接', () => {
  it('多字段认证优先提取 Key，资源信息只用于 Models.dev 的地址模板', () => {
    const credential = { SNOWFLAKE_ACCOUNT: 'account', SNOWFLAKE_CORTEX_PAT: 'credential' }
    expect(credentialApiKey(['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_CORTEX_PAT'], credential)).toBe(
      'credential',
    )
    expect(
      resolveCatalogApi(
        'https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1',
        credential,
      ),
    ).toContain('https://account.snowflakecomputing.com')
    expect(() => resolveCatalogApi('https://${UNCONFIGURED_TEST_RESOURCE}/v1', {})).toThrow(
      'UNCONFIGURED_TEST_RESOURCE',
    )
  })
  it.each([
    [
      '@ai-sdk/anthropic',
      'claude-sonnet-5-5',
      {
        id: 'native',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [{ type: 'text', text: JSON.stringify(value) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 4 },
      },
    ],
    [
      '@ai-sdk/google',
      'gemini-2.5-flash',
      {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: JSON.stringify(value) }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
      },
    ],
    ['@ai-sdk/mistral', 'mistral-large-latest', completion(value)],
    [
      '@ai-sdk/amazon-bedrock',
      'amazon.nova-pro-v1:0',
      {
        output: { message: { role: 'assistant', content: [{ text: JSON.stringify(value) }] } },
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      },
    ],
    ['venice-ai-sdk-provider', 'test-model', completion(value)],
  ])('%s 使用真实 SDK 和原生结构化格式生成', async (sdk, id, response) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response))
    const model = await createProviderModel(
      makeCatalog(String(sdk), String(id)),
      'test',
      String(id),
      'test-key-not-real',
      fetcher,
    )
    const result = await generateText({
      model,
      output: Output.object({ schema }),
      prompt: 'Return ready=true.',
      maxRetries: 0,
    })
    expect(result.output).toEqual(value)
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('user-agent')).toBe(false)
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    if (sdk === '@ai-sdk/anthropic') {
      expect(body.max_tokens).toBe(128000)
      expect(body.output_config.format.type).toBe('json_schema')
    } else if (sdk === '@ai-sdk/google') {
      expect(body.generationConfig.responseMimeType).toBe('application/json')
      expect(body.generationConfig.maxOutputTokens).toBeUndefined()
    } else {
      expect(body.max_tokens).toBeUndefined()
      expect(body.inferenceConfig?.maxTokens).toBeUndefined()
    }
  })

  it.each([
    '@ai-sdk/openai-compatible',
    '@ai-sdk/groq',
    '@ai-sdk/deepinfra',
    '@ai-sdk/cerebras',
    '@ai-sdk/togetherai',
    '@openrouter/ai-sdk-provider',
    '@aihubmix/ai-sdk-provider',
    '@saladtechnologies-oss/ai-sdk-provider',
    'merge-gateway-ai-sdk-provider',
    '@qvac/ai-sdk-provider',
  ])('%s 发送严格 JSON schema，省略可选输出限制', async (sdk) => {
    const catalog = makeCatalog(sdk, 'test-model')
    catalog.test.api = 'https://mock.example/v1'
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(completion(value)))
    const model = await createProviderModel(catalog, 'test', 'test-model', 'test-key', fetcher)
    expect(
      (
        await generateText({
          model,
          prompt: 'Ready?',
          output: Output.object({ schema }),
          maxRetries: 0,
        })
      ).output,
    ).toEqual(value)
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { schema: { type: 'object' } },
    })
    expect(body.max_tokens).toBeUndefined()
    expect(body.max_completion_tokens).toBeUndefined()
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('user-agent')).toBe(false)
  })

  it.each(['@ai-sdk/openai', '@ai-sdk/azure', '@ai-sdk/xai', '@ai-sdk/gateway'])(
    '%s 使用 Responses / Gateway 原生格式',
    async (sdk) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          sdk === '@ai-sdk/gateway'
            ? {
                content: [{ type: 'text', text: JSON.stringify(value) }],
                finishReason: { unified: 'stop' },
                usage: { inputTokens: { total: 10 }, outputTokens: { total: 4 } },
              }
            : response(value),
        ),
      )
      const model = await createProviderModel(
        makeCatalog(sdk, 'test-model'),
        'test',
        'test-model',
        sdk === '@ai-sdk/azure'
          ? JSON.stringify({ apiKey: 'test-key', resourceName: 'test-resource' })
          : 'test-key',
        fetcher,
      )
      expect(
        (
          await generateText({
            model,
            prompt: 'Ready?',
            output: Output.object({ schema }),
            maxRetries: 0,
          })
        ).output,
      ).toEqual(value)
      expect(String(fetcher.mock.calls[0][0])).toContain(
        sdk === '@ai-sdk/azure'
          ? 'test-resource.openai.azure.com'
          : sdk === '@ai-sdk/openai'
            ? 'api.openai.com'
            : sdk === '@ai-sdk/xai'
              ? 'api.x.ai'
              : 'ai-gateway.vercel.sh',
      )
      expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('user-agent')).toBe(false)
    },
  )

  it('Vertex Express 的浏览器入口使用 API Key 和原生 JSON schema', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: JSON.stringify(value) }] },
            finishReason: 'STOP',
          },
        ],
      }),
    )
    const model = await createProviderModel(
      makeCatalog('@ai-sdk/google-vertex', 'gemini-2.5-flash'),
      'test',
      'gemini-2.5-flash',
      'test-key',
      fetcher,
    )
    expect(
      (
        await generateText({
          model,
          prompt: 'Ready?',
          output: Output.object({ schema }),
          maxRetries: 0,
        })
      ).output,
    ).toEqual(value)
    expect(String(fetcher.mock.calls[0][0])).toContain('aiplatform.googleapis.com')
  })

  it('模型级 Mantle / Responses 覆盖保留 AWS 认证并展开 Models.dev 区域地址', async () => {
    const catalog = makeCatalog('@ai-sdk/amazon-bedrock', 'openai.gpt-5.4')
    catalog.test.models['openai.gpt-5.4'].provider = {
      npm: '@ai-sdk/amazon-bedrock/mantle',
      api: 'https://bedrock-mantle.${AWS_REGION}.api.aws/openai/v1',
      shape: 'responses',
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response(value)))
    const model = await createProviderModel(catalog, 'test', 'openai.gpt-5.4', 'test-key', fetcher)
    expect(
      (
        await generateText({
          model,
          prompt: 'Ready?',
          output: Output.object({ schema }),
          maxRetries: 0,
        })
      ).output,
    ).toEqual(value)
    expect(String(fetcher.mock.calls[0][0])).toBe(
      'https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses',
    )
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe(
      'Bearer test-key',
    )
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({
      model: 'openai.gpt-5.4',
      store: false,
      text: { format: { type: 'json_schema', strict: true } },
    })
  })

  it('Azure Foundry 兼容覆盖项保留资源 Key，使用稳定 API 版本和参数转发', async () => {
    const catalog = makeCatalog('@ai-sdk/azure', 'kimi-k2.6')
    catalog.test.models['kimi-k2.6'].provider = {
      npm: '@ai-sdk/openai-compatible',
      api: 'https://${AZURE_RESOURCE_NAME}.services.ai.azure.com/models',
      shape: 'completions',
    }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(completion(value)))
    const model = await createProviderModel(
      catalog,
      'test',
      'kimi-k2.6',
      JSON.stringify({
        apiKey: 'test-key',
        resourceName: 'test-resource',
      }),
      fetcher,
    )
    expect(
      (
        await generateText({
          model,
          prompt: 'Ready?',
          output: Output.object({ schema }),
          maxRetries: 0,
        })
      ).output,
    ).toEqual(value)
    const url = new URL(String(fetcher.mock.calls[0][0]))
    expect(url.href).toBe(
      'https://test-resource.services.ai.azure.com/models/chat/completions?api-version=2025-04-01',
    )
    const headers = new Headers(fetcher.mock.calls[0][1]?.headers)
    expect(headers.get('api-key')).toBe('test-key')
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('extra-parameters')).toBe('pass-through')
  })

  it('Cohere 使用原生 JSON schema，保留服务商 usage', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(value) }] },
        finish_reason: 'COMPLETE',
        usage: { tokens: { input_tokens: 10, output_tokens: 4 } },
      }),
    )
    const model = await createProviderModel(
      makeCatalog('@ai-sdk/cohere', 'command-a-03-2025'),
      'test',
      'command-a-03-2025',
      'test-key',
      fetcher,
    )
    expect(
      (
        await generateText({
          model,
          prompt: 'Ready?',
          output: Output.object({ schema }),
          maxRetries: 0,
        })
      ).output,
    ).toEqual(value)
    expect(
      JSON.parse(String(fetcher.mock.calls[0][1]?.body)).response_format.json_schema,
    ).toMatchObject({ type: 'object' })
  })

  it('Vertex Anthropic 的 Edge 入口使用原生格式并省去模型 ID 前缀', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: 'native',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [{ type: 'text', text: JSON.stringify(value) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
    )
    const model = await createProviderModel(
      makeCatalog('@ai-sdk/google-vertex/anthropic', 'claude-sonnet-5-5'),
      'test',
      'claude-sonnet-5-5',
      JSON.stringify({ project: 'project', location: 'global', accessToken: 'test-token' }),
      fetcher,
    )
    expect(
      (
        await generateText({
          model,
          prompt: 'Ready?',
          output: Output.object({ schema }),
          maxRetries: 0,
        })
      ).output,
    ).toEqual(value)
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(body.model).toBeUndefined()
    expect(body.output_config.format.type).toBe('json_schema')
    expect(String(fetcher.mock.calls[0][0])).toContain('claude-sonnet-5-5:rawPredict')
  })

  it('watsonx 社区 V3 SDK 经过 Vercel V4 兼容层，完成 IAM 和严格 schema 生成', async () => {
    const iam = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        access_token: 'test-token',
        expiration: Math.floor(Date.now() / 1000) + 3600,
      }),
    )
    vi.stubGlobal('fetch', iam)
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(completion(value)))
      const catalog = makeCatalog('watsonx-ai-provider', 'ibm/granite-4-h-small')
      catalog.test.env = ['WATSONX_AI_APIKEY', 'WATSONX_AI_PROJECT_ID']
      const model = await createProviderModel(
        catalog,
        'test',
        'ibm/granite-4-h-small',
        JSON.stringify({ WATSONX_AI_APIKEY: 'test-watson-key', WATSONX_AI_PROJECT_ID: 'project' }),
        fetcher,
      )
      expect(
        (
          await generateText({
            model,
            prompt: 'Ready?',
            output: Output.object({ schema }),
            maxRetries: 0,
          })
        ).output,
      ).toEqual(value)
      expect(String(iam.mock.calls[0][0])).toContain('iam.cloud.ibm.com')
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({
        project_id: 'project',
        response_format: { type: 'json_schema' },
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([false, true])(
    'SAP 浏览器适配完整认证、部署查询、严格 schema 和流式=%s',
    async (streaming) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input)
        if (url.endsWith('/oauth/token'))
          return Response.json({ access_token: 'test-access', expires_in: 3600 })
        if (url.includes('/lm/deployments'))
          return Response.json({ resources: [{ id: 'deployment', status: 'RUNNING' }] })
        return streaming
          ? new Response(
              sse(value)
                .join('')
                .split('\n\n')
                .filter((part) => part && !part.includes('[DONE]'))
                .map(
                  (part) =>
                    `data: ${JSON.stringify({ final_result: JSON.parse(part.slice(6).trim()) })}\n\n`,
                )
                .join(''),
              { headers: { 'content-type': 'text/event-stream' } },
            )
          : Response.json({ final_result: completion(value) })
      })
      const key = {
        clientid: 'client',
        clientsecret: 'test-secret',
        url: 'https://sap-auth.example',
        serviceurls: { AI_API_URL: 'https://sap.example/v2' },
      }
      const model = await createProviderModel(
        makeCatalog('@jerome-benoit/sap-ai-provider-v2', 'gpt-5.4'),
        'test',
        'gpt-5.4',
        JSON.stringify(key),
        fetcher,
      )
      const request = { model, prompt: 'Ready?', output: Output.object({ schema }), maxRetries: 0 }
      const result = streaming
        ? await streamText(request).output
        : (await generateText(request)).output
      expect(result).toEqual(value)
      const body = JSON.parse(String(fetcher.mock.calls[2][1]?.body))
      expect(body.config.modules.prompt_templating.prompt.response_format.json_schema.strict).toBe(
        true,
      )
      expect(body.config.modules.prompt_templating.model.params?.max_tokens).toBeUndefined()
    },
  )

  it.each([false, true])(
    'GitLab 浏览器直连完成 token 交换和 Responses，流式=%s',
    async (streaming) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) =>
        String(input).includes('/direct_access')
          ? Response.json({
              token: 'test-duo-token',
              headers: { 'x-gitlab-feature-enabled': 'true' },
            })
          : streaming
            ? new Response(responseSse(value).join(''), {
                headers: { 'content-type': 'text/event-stream' },
              })
            : Response.json(response(value)),
      )
      const model = await createProviderModel(
        makeCatalog('gitlab-ai-provider', 'duo-chat-gpt-5-4'),
        'test',
        'duo-chat-gpt-5-4',
        'test-key',
        fetcher,
      )
      const request = { model, prompt: 'Ready?', output: Output.object({ schema }), maxRetries: 0 }
      expect(
        streaming ? await streamText(request).output : (await generateText(request)).output,
      ).toEqual(value)
      const body = JSON.parse(String(fetcher.mock.calls[1][1]?.body))
      expect(body.model).toBe('gpt-5.4')
      expect(body.text.format.strict).toBe(true)
      expect(body.max_output_tokens).toBeUndefined()
    },
  )

  it('Cloudflare 保留完整 Gateway model ID，模型 SDK override 仍经由 Gateway 路由', async () => {
    const catalog = makeCatalog('ai-gateway-provider', 'anthropic/claude-opus-4.5')
    catalog.test.models['anthropic/claude-opus-4.5'].provider = { npm: '@ai-sdk/anthropic' }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(completion(value)))
    const model = await createProviderModel(
      catalog,
      'test',
      'anthropic/claude-opus-4.5',
      JSON.stringify({
        apiKey: 'test-key',
        CLOUDFLARE_ACCOUNT_ID: 'account',
        CLOUDFLARE_GATEWAY_ID: 'gateway',
      }),
      fetcher,
    )
    expect(
      (
        await generateText({
          model,
          prompt: 'Ready?',
          output: Output.object({ schema }),
          maxRetries: 0,
        })
      ).output,
    ).toEqual(value)
    expect(String(fetcher.mock.calls[0][0])).toBe(
      'https://gateway.ai.cloudflare.com/v1/account/gateway',
    )
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))[0].query.model).toBe(
      'anthropic/claude-opus-4.5',
    )
  })
})
