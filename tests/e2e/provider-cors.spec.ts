import { createServer, type IncomingHttpHeaders } from 'node:http'
import { expect } from '@playwright/test'
import { test } from './fixtures'
import { capabilityFixture, completion, response, responseSse, sse } from '../fixtures'

test('严格 CORS 服务商通过非流式与流式测试，浏览器负责 User-Agent', async ({ page }) => {
  const calls: { headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = []
  const preflights: string[][] = []
  const gatewayHeaders = [
    'ai-gateway-auth-method',
    'ai-gateway-protocol-version',
    'ai-language-model-id',
    'ai-language-model-specification-version',
    'ai-language-model-streaming',
  ]
  // Use a real cross-origin server; network interception can bypass browser CORS checks.
  const server = createServer(async (request, reply) => {
    reply.setHeader('Access-Control-Allow-Origin', '*')
    reply.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    reply.setHeader(
      'Access-Control-Allow-Headers',
      ['Authorization', 'Content-Type', ...gatewayHeaders].join(', '),
    )
    if (request.method === 'OPTIONS') {
      preflights.push(
        String(request.headers['access-control-request-headers'] ?? '')
          .toLowerCase()
          .split(',')
          .map((header) => header.trim())
          .filter(Boolean),
      )
      reply.writeHead(204).end()
      return
    }
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw) as Record<string, unknown>
    calls.push({ headers: request.headers, body })
    const gateway = request.url?.endsWith('/language-model')
    const streaming = gateway
      ? request.headers['ai-language-model-streaming'] === 'true'
      : body.stream === true
    const json = JSON.stringify(capabilityFixture)
    const usage = { inputTokens: { total: 10 }, outputTokens: { total: 30 } }
    if (gateway) {
      reply.setHeader('Content-Type', streaming ? 'text/event-stream' : 'application/json')
      reply.end(
        streaming
          ? [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text' },
              { type: 'text-delta', id: 'text', delta: json },
              { type: 'text-end', id: 'text' },
              { type: 'finish', finishReason: { unified: 'stop' }, usage },
            ]
              .map((part) => `data: ${JSON.stringify(part)}\n\n`)
              .join('')
          : JSON.stringify({
              content: [{ type: 'text', text: json }],
              finishReason: { unified: 'stop' },
              usage,
            }),
      )
      return
    }
    const responses = request.url?.endsWith('/responses')
    reply.setHeader('Content-Type', body.stream ? 'text/event-stream' : 'application/json')
    reply.end(
      body.stream
        ? (responses ? responseSse(capabilityFixture) : sse(capabilityFixture)).join('')
        : JSON.stringify(responses ? response(capabilityFixture) : completion(capabilityFixture)),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('CORS test server did not start')
  const providers = [
    {
      id: 'vercel',
      name: 'Vercel AI Gateway',
      npm: '@ai-sdk/gateway',
      model: 'deepseek/deepseek-v4.1-flash',
    },
    { id: 'native', name: 'Native CORS', npm: '@ai-sdk/mistral', model: 'test-model' },
    {
      id: 'compatible',
      name: 'Compatible CORS',
      npm: '@ai-sdk/openai-compatible',
      model: 'test-model',
    },
    {
      id: 'responses',
      name: 'Responses CORS',
      npm: '@ai-sdk/openai',
      shape: 'responses',
      model: 'test-model',
    },
  ]
  try {
    const catalog = Object.fromEntries(
      providers.map((provider) => [
        provider.id,
        {
          ...provider,
          api: `http://127.0.0.1:${address.port}/v1`,
          env: ['TEST_API_KEY'],
          models: {
            [provider.model]: {
              id: provider.model,
              name: 'CORS test model',
              structured_output: true,
              temperature: false,
              modalities: { input: ['text'], output: ['text'] },
              limit: { context: 1000000, output: 128000 },
              ...(provider.shape ? { provider: { shape: provider.shape } } : {}),
            },
          },
        },
      ]),
    )
    await page.context().unrouteAll({ behavior: 'wait' })
    await page.addInitScript((catalog) => {
      const nativeFetch = globalThis.fetch
      globalThis.fetch = (input, init) =>
        (input instanceof Request ? input.url : String(input)) === 'https://models.dev/api.json'
          ? Promise.resolve(Response.json(catalog))
          : nativeFetch(input, init)
    }, catalog)
    await page.goto('./', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '渠道管理', exact: true }).click()
    await page.getByRole('button', { name: '新建渠道', exact: true }).click()
    for (const provider of providers) {
      const start = calls.length
      await page.getByRole('combobox', { name: 'Provider', exact: true }).click()
      await page.getByRole('option', { name: provider.name, exact: true }).click()
      await page.getByLabel('API Key', { exact: true }).fill('test-key-not-real')
      await page.locator('form').getByRole('button', { name: '测试渠道', exact: true }).click()
      await expect(
        page.getByText('测试通过 · 连接、JSON 校验与流式', { exact: false }),
        provider.name,
      ).toBeVisible()
      const requests = calls.slice(start)
      expect(requests, provider.name).toHaveLength(2)
      expect(
        requests.map((call) =>
          provider.npm === '@ai-sdk/gateway'
            ? call.headers['ai-language-model-streaming'] === 'true'
            : (call.body.stream ?? false),
        ),
      ).toEqual([false, true])
      for (const call of requests) {
        expect(call.headers.authorization).toBe('Bearer test-key-not-real')
        expect(call.headers['user-agent']).not.toContain('ai-sdk')
        if (provider.npm === '@ai-sdk/gateway') {
          expect(call.headers['ai-language-model-id']).toBe(provider.model)
          expect(call.headers['ai-gateway-auth-method']).toBe('api-key')
          expect(call.headers['ai-language-model-specification-version']).toBe('4')
          expect(call.body.responseFormat).toMatchObject({
            type: 'json',
            name: 'ChannelCapability',
            schema: { type: 'object', additionalProperties: false },
          })
        }
      }
    }
    expect(preflights.length).toBeGreaterThan(0)
    expect(preflights.every((headers) => !headers.includes('user-agent'))).toBe(true)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
