import { expect } from '@playwright/test'
import { test } from './fixtures'
import { capabilityFixture, completion, response, responseSse, sse } from '../fixtures'
import { generateKeyPairSync } from 'node:crypto'

const serviceKey = JSON.stringify({
  project_id: 'test-project',
  client_email: 'test@example.invalid',
  private_key: generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString(),
})

const providers = [
  { id: 'anthropic', npm: '@ai-sdk/anthropic', model: 'claude-sonnet-5-5', key: 'test-key' },
  { id: 'google', npm: '@ai-sdk/google', model: 'gemini-2.5-flash', key: 'test-key' },
  { id: 'vertex', npm: '@ai-sdk/google-vertex', model: 'gemini-2.5-flash', key: 'test-key' },
  {
    id: 'vertex-service-account',
    npm: '@ai-sdk/google-vertex',
    model: 'gemini-2.5-flash',
    key: JSON.stringify({ GOOGLE_APPLICATION_CREDENTIALS: serviceKey }),
  },
  {
    id: 'vertex-maas',
    npm: '@ai-sdk/google-vertex',
    model: 'meta/llama-4-maverick-17b-128e-instruct-maas',
    key: serviceKey,
  },
  {
    id: 'vertex-anthropic',
    npm: '@ai-sdk/google-vertex/anthropic',
    model: 'claude-sonnet-5-5',
    key: JSON.stringify({ project: 'project', location: 'global', accessToken: 'test-token' }),
  },
  { id: 'bedrock', npm: '@ai-sdk/amazon-bedrock', model: 'amazon.nova-pro-v1:0', key: 'test-key' },
  { id: 'bedrock-mantle', npm: '@ai-sdk/amazon-bedrock', model: 'openai.gpt-5.4', key: 'test-key' },
  {
    id: 'bedrock-mantle-sigv4',
    npm: '@ai-sdk/amazon-bedrock',
    model: 'openai.gpt-5.4',
    key: JSON.stringify({
      AWS_ACCESS_KEY_ID: 'test-access-id',
      AWS_SECRET_ACCESS_KEY: 'test-secret',
      AWS_REGION: 'us-east-1',
    }),
  },
  {
    id: 'bedrock-sigv4',
    npm: '@ai-sdk/amazon-bedrock',
    model: 'amazon.nova-pro-v1:0',
    key: JSON.stringify({
      AWS_ACCESS_KEY_ID: 'test-access-id',
      AWS_SECRET_ACCESS_KEY: 'test-secret',
      AWS_REGION: 'us-east-1',
    }),
  },
  {
    id: 'sap',
    npm: '@jerome-benoit/sap-ai-provider-v2',
    model: 'gpt-5.4',
    key: JSON.stringify({
      clientid: 'client',
      clientsecret: 'test-secret',
      url: 'https://sap-auth.example',
      serviceurls: { AI_API_URL: 'https://sap.example/v2' },
    }),
  },
  { id: 'gitlab', npm: 'gitlab-ai-provider', model: 'duo-chat-gpt-5-4', key: 'test-key' },
  {
    id: 'cloudflare',
    npm: 'ai-gateway-provider',
    model: 'anthropic/claude-opus-4.5',
    key: JSON.stringify({
      apiKey: 'test-key',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_GATEWAY_ID: 'gateway',
    }),
  },
  {
    id: 'watsonx',
    npm: 'watsonx-ai-provider',
    model: 'ibm/granite-4-h-small',
    key: JSON.stringify({ apiKey: 'test-key', WATSONX_AI_PROJECT_ID: 'project' }),
  },
  {
    id: 'azure',
    npm: '@ai-sdk/azure',
    model: 'gpt-5.4',
    key: JSON.stringify({ apiKey: 'test-key', resourceName: 'test-resource' }),
  },
  {
    id: 'azure-cognitive-services',
    npm: '@ai-sdk/azure',
    model: 'gpt-5.4',
    key: JSON.stringify({ apiKey: 'test-key', resourceName: 'test-resource' }),
  },
  {
    id: 'azure-foundry',
    npm: '@ai-sdk/azure',
    model: 'kimi-k2.6',
    key: JSON.stringify({ apiKey: 'test-key', resourceName: 'test-resource' }),
  },
  {
    id: 'azure-anthropic',
    npm: '@ai-sdk/azure',
    model: 'claude-sonnet-5-5',
    key: JSON.stringify({ apiKey: 'test-key', resourceName: 'test-resource' }),
  },
]

const json = JSON.stringify(capabilityFixture)
const anthropic = {
  id: 'mock',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [{ type: 'text', text: json }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 30 },
}
const google = {
  candidates: [{ content: { role: 'model', parts: [{ text: json }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 30, totalTokenCount: 40 },
}
const bedrock = {
  output: { message: { role: 'assistant', content: [{ text: json }] } },
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 30, totalTokens: 40 },
}
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const anthropicStream = [
  {
    type: 'message_start',
    message: {
      ...anthropic,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: json } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 30 },
  },
  { type: 'message_stop' },
]
  .map(event)
  .join('')

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function bedrockEvent(type: string, value: unknown) {
  const headers = Buffer.concat(
    Object.entries({
      ':message-type': 'event',
      ':event-type': type,
      ':content-type': 'application/json',
    }).map(([name, content]) => {
      const result = Buffer.alloc(1 + name.length + 1 + 2 + content.length)
      result.writeUInt8(name.length, 0)
      result.write(name, 1)
      result.writeUInt8(7, name.length + 1)
      result.writeUInt16BE(content.length, name.length + 2)
      result.write(content, name.length + 4)
      return result
    }),
  )
  const body = Buffer.from(JSON.stringify(value))
  const result = Buffer.alloc(16 + headers.length + body.length)
  result.writeUInt32BE(result.length, 0)
  result.writeUInt32BE(headers.length, 4)
  result.writeUInt32BE(crc32(result.subarray(0, 8)), 8)
  headers.copy(result, 12)
  body.copy(result, 12 + headers.length)
  result.writeUInt32BE(crc32(result.subarray(0, -4)), result.length - 4)
  return result
}
const bedrockStream = Buffer.concat([
  bedrockEvent('messageStart', { role: 'assistant' }),
  bedrockEvent('contentBlockStart', { contentBlockIndex: 0, start: {} }),
  bedrockEvent('contentBlockDelta', { contentBlockIndex: 0, delta: { text: json } }),
  bedrockEvent('contentBlockStop', { contentBlockIndex: 0 }),
  bedrockEvent('messageStop', { stopReason: 'end_turn' }),
  bedrockEvent('metadata', { usage: { inputTokens: 10, outputTokens: 30, totalTokens: 40 } }),
])

test('GitHub Pages 浏览器运行原生 SDK、云服务认证和 Gateway 的完整能力测试', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('https://models.dev/api.json', (route) =>
    route.fulfill({
      json: Object.fromEntries(
        providers.map((provider) => [
          provider.id,
          {
            id: provider.id,
            name: provider.id,
            npm: provider.npm,
            env: ['TEST_API_KEY'],
            models: {
              [provider.model]: {
                id: provider.model,
                name: provider.model,
                structured_output: true,
                temperature: false,
                modalities: { input: ['text'], output: ['text'] },
                limit: { context: 1000000, output: 128000 },
                ...(provider.id === 'vertex-maas'
                  ? {
                      provider: {
                        npm: '@ai-sdk/openai-compatible',
                        api: 'https://${GOOGLE_VERTEX_ENDPOINT}/v1/projects/${GOOGLE_VERTEX_PROJECT}/locations/${GOOGLE_VERTEX_LOCATION}/endpoints/openapi',
                      },
                    }
                  : ['azure-foundry', 'azure-anthropic'].includes(provider.id)
                    ? {
                        provider: {
                          npm:
                            provider.id === 'azure-anthropic'
                              ? '@ai-sdk/anthropic'
                              : '@ai-sdk/openai-compatible',
                          api: `https://\${AZURE_RESOURCE_NAME}.services.ai.azure.com/${provider.id === 'azure-anthropic' ? 'anthropic/v1' : 'models'}`,
                        },
                      }
                    : provider.id === 'cloudflare'
                      ? { provider: { npm: '@ai-sdk/anthropic' } }
                      : provider.id.startsWith('bedrock-mantle')
                        ? {
                            provider: {
                              npm: '@ai-sdk/amazon-bedrock/mantle',
                              api: 'https://bedrock-mantle.${AWS_REGION}.api.aws/openai/v1',
                              shape: 'responses',
                            },
                          }
                        : {}),
              },
            },
          },
        ]),
      ),
    }),
  )
  const hosts = [
    'api.anthropic.com',
    'generativelanguage.googleapis.com',
    'aiplatform.googleapis.com',
    'oauth2.googleapis.com',
    'sap-auth.example',
    'sap.example',
    'gitlab.com',
    'cloud.gitlab.com',
    'gateway.ai.cloudflare.com',
    'iam.cloud.ibm.com',
    'us-south.ml.cloud.ibm.com',
    'test-resource.openai.azure.com',
    'test-resource.services.ai.azure.com',
  ]
  const requests: { url: string; body: Record<string, unknown> }[] = []
  await page.route(
    (url) =>
      hosts.includes(url.hostname) ||
      url.hostname.startsWith('bedrock-runtime.') ||
      url.hostname.startsWith('bedrock-mantle.'),
    async (route) => {
      const url = route.request().url()
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
      if (route.request().method() === 'OPTIONS')
        return route.fulfill({ status: 204, headers: cors })
      if (url === 'https://oauth2.googleapis.com/token') {
        const form = new URLSearchParams(route.request().postData()!)
        expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
        expect(form.get('assertion')?.split('.')).toHaveLength(3)
        return route.fulfill({ json: { access_token: 'test-token' }, headers: cors })
      }
      if (url.endsWith('/oauth/token'))
        return route.fulfill({
          json: { access_token: 'test-token', expires_in: 3600 },
          headers: cors,
        })
      if (url.includes('/lm/deployments'))
        return route.fulfill({
          json: { resources: [{ id: 'deployment', status: 'RUNNING' }] },
          headers: cors,
        })
      if (url.endsWith('/direct_access'))
        return route.fulfill({ json: { token: 'test-token', headers: {} }, headers: cors })
      if (url.includes('iam.cloud.ibm.com'))
        return route.fulfill({
          json: { access_token: 'test-token', expiration: Math.floor(Date.now() / 1000) + 3600 },
          headers: cors,
        })
      const body = route.request().postDataJSON()
      const headers = route.request().headers()
      if (url.includes('/endpoints/openapi'))
        expect(headers.authorization).toBe('Bearer test-token')
      if (url.includes('.services.ai.azure.com')) expect(headers['api-key']).toBe('test-key')
      if (url.includes('.services.ai.azure.com/models/')) {
        expect(new URL(url).searchParams.get('api-version')).toBe('2025-04-01')
        expect(headers['extra-parameters']).toBe('pass-through')
        expect(headers.authorization).toBeUndefined()
      }
      requests.push({ url, body })
      const streaming =
        body.stream ||
        body[0]?.query.stream ||
        body.config?.stream?.enabled ||
        url.includes('stream') ||
        url.includes('converse-stream')
      const isAnthropic =
        url.includes('anthropic.com') ||
        url.includes('/anthropic/') ||
        url.includes('rawPredict') ||
        url.includes('streamRawPredict')
      const isGoogle = url.includes('generativelanguage') || url.includes('publishers/google')
      const isBedrock = url.includes('bedrock-runtime')
      const isSAP = url.includes('sap.example')
      const isResponses = url.includes('/responses')
      const data = isAnthropic
        ? anthropic
        : isGoogle
          ? google
          : isBedrock
            ? bedrock
            : isSAP
              ? { final_result: completion(capabilityFixture) }
              : isResponses
                ? response(capabilityFixture)
                : completion(capabilityFixture)
      const stream = isAnthropic
        ? anthropicStream
        : isGoogle
          ? event(google)
          : isBedrock
            ? bedrockStream
            : isSAP
              ? sse(capabilityFixture)
                  .join('')
                  .split('\n\n')
                  .filter((item) => item && !item.includes('[DONE]'))
                  .map((item) => event({ final_result: JSON.parse(item.slice(6)) }))
                  .join('')
              : isResponses
                ? responseSse(capabilityFixture).join('')
                : sse(capabilityFixture).join('')
      await route.fulfill({
        headers: {
          ...cors,
          'content-type': streaming
            ? isBedrock
              ? 'application/vnd.amazon.eventstream'
              : 'text/event-stream'
            : 'application/json',
        },
        body: streaming ? stream : JSON.stringify(data),
      })
    },
  )
  await page.goto('./')
  await page.getByRole('button', { name: '渠道管理', exact: true }).click()
  await page.getByRole('button', { name: '新建渠道', exact: true }).click()
  for (const provider of providers) {
    const start = requests.length
    await page.getByRole('combobox', { name: 'Provider', exact: true }).click()
    await page.getByRole('option', { name: provider.id, exact: true }).click()
    await page.getByLabel('API Key', { exact: true }).fill(provider.key)
    await page.locator('form').getByRole('button', { name: '测试渠道', exact: true }).click()
    await expect(
      page.getByText('测试通过 · 连接、结构化与流式', { exact: false }),
      provider.id,
    ).toBeVisible()
    const calls = requests.slice(start)
    expect(calls, provider.id).toHaveLength(2)
    for (const call of calls) {
      expect(call.body.max_tokens, provider.id).toBe(
        ['anthropic', 'vertex-anthropic', 'azure-anthropic'].includes(provider.id)
          ? 128000
          : undefined,
      )
      expect(call.body.max_output_tokens, provider.id).toBeUndefined()
      expect(call.body.max_completion_tokens, provider.id).toBeUndefined()
    }
    expect(errors, provider.id).toEqual([])
  }
  expect(requests).toHaveLength(providers.length * 2)
})
