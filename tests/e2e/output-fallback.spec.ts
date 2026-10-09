import { expect, type Page } from '@playwright/test'
import { test, expandChannel, openChannels } from './fixtures'
import { capabilityFixture } from '../fixtures'
import { catalogFixture } from '../model-catalog-fixture'
import { protocolResponse } from '../provider-protocol-fixtures'
import { apiProtocols, type ApiProtocol } from '../../src/lib/types'
import { endpointLabels } from '../../src/lib/channels'

async function prepare(page: Page, structured = true) {
  const catalog = catalogFixture()
  for (const model of Object.values(catalog.mock.models)) {
    model.structured_output = structured
    Object.assign(model.limit, { output: 128000 })
  }
  await page.route('https://models.dev/api.json', (route) => route.fulfill({ json: catalog }))
  await page.goto('./')
  await openChannels(page)
  await page.getByRole('button', { name: '新建渠道', exact: true }).click()
  await expandChannel(page, '新渠道')
  await page.getByRole('combobox', { name: 'Provider', exact: true }).click()
  await page.getByRole('option', { name: '测试 Provider', exact: true }).click()
  await page.getByRole('combobox', { name: '模型', exact: true }).click()
  await page.getByRole('option', { name: 'test-model · test-model', exact: true }).click()
  await page.getByLabel('API Key', { exact: true }).fill('test-key')
  await page.getByLabel('Base URL（可选）', { exact: true }).fill('https://endpoint.example')
}

async function selectProtocol(page: Page, protocol: ApiProtocol) {
  await page.getByRole('combobox', { name: 'API 端点', exact: true }).click()
  await page.getByRole('option', { name: endpointLabels[protocol], exact: true }).click()
}

test('七种端点在纯前端使用官方 SDK 完成非流式和流式测试', async ({ page }) => {
  let protocol: ApiProtocol = 'chat-completions'
  const calls: { url: string; body: Record<string, unknown> }[] = []
  await page.route('https://endpoint.example/**', async (route) => {
    const body = route.request().postDataJSON()
    const url = route.request().url()
    calls.push({ url, body })
    const result = protocolResponse(
      protocol,
      capabilityFixture,
      body.stream || url.includes('streamGenerateContent'),
    )
    await route.fulfill({
      headers: { 'access-control-allow-origin': '*', 'content-type': result.contentType },
      body: result.body,
    })
  })
  await prepare(page)
  for (const next of apiProtocols.filter((protocol) => protocol !== 'native')) {
    protocol = next
    await selectProtocol(page, next)
    await page.locator('form').getByRole('button', { name: '测试渠道', exact: true }).click()
    await expect(page.getByText(/测试通过 ·/)).toBeVisible()
    await expect(page.getByRole('button', { name: '使用此渠道', exact: true })).toBeEnabled()
    const recent = calls.slice(-2)
    expect(new URL(recent[0].url).pathname).toBe(
      endpointLabels[next].replace('{model}', 'test-model'),
    )
    for (const call of recent) {
      expect(call.body.max_tokens).toBe(next === 'messages' ? 128000 : undefined)
      expect(call.body.max_output_tokens ?? call.body.max_completion_tokens).toBeUndefined()
    }
  }
  expect(calls).toHaveLength(14)
  await selectProtocol(page, 'native')
  await page.getByRole('combobox', { name: 'Provider SDK', exact: true }).click()
  await expect(
    page.getByRole('option', { name: '@ai-sdk/openai-compatible', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('option', { name: '@ai-sdk/anthropic-aws', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('option', { name: '@ai-sdk/open-responses', exact: true }),
  ).toBeVisible()
})

test('Models.dev 的非结构化模型可选择，JSON mode 失败后提示词 JSON 在本地修复', async ({
  page,
}) => {
  const calls: Record<string, unknown>[] = []
  await page.route('https://endpoint.example/**', async (route) => {
    const body = route.request().postDataJSON()
    calls.push(body)
    if (body.response_format) {
      expect(body.response_format.type).toBe('json_object')
      return route.fulfill({
        status: 400,
        headers: { 'access-control-allow-origin': '*' },
        json: { error: { message: 'JSON mode response_format unsupported' } },
      })
    }
    expect(body.messages[0].content).toContain('JSON Schema')
    const broken = `\`\`\`json\n${JSON.stringify(capabilityFixture).replace('"ready":true', '"ready":True').replace(/}$/, ',}')}\n\`\`\``
    const result = protocolResponse('chat-completions', broken, body.stream)
    await route.fulfill({
      headers: { 'access-control-allow-origin': '*', 'content-type': result.contentType },
      body: result.body,
    })
  })
  await prepare(page, false)
  await selectProtocol(page, 'chat-completions')
  await page.locator('form').getByRole('button', { name: '测试渠道', exact: true }).click()
  await expect(page.getByText(/测试通过 ·/)).toBeVisible()
  await expect(page.getByLabel('协议测试结果')).toContainText(
    '非流式 提示词 JSON · 流式 提示词 JSON',
  )
  await expect(page.getByRole('button', { name: '使用此渠道', exact: true })).toBeEnabled()
  expect(calls).toHaveLength(4)
  expect(calls.map((body) => body.response_format)).toEqual([
    { type: 'json_object' },
    undefined,
    { type: 'json_object' },
    undefined,
  ])
})

test('Responses 的格式错误保留 HTTP 信息，非流式和流式都能回退到提示词 JSON', async ({ page }) => {
  const formats: (string | undefined)[] = []
  await page.route('https://endpoint.example/**', async (route) => {
    const body = route.request().postDataJSON()
    formats.push(body.text?.format?.type)
    if (body.text?.format)
      return route.fulfill({
        status: 400,
        headers: { 'access-control-allow-origin': '*' },
        json: { error: { message: 'JSON response_format schema unsupported' } },
      })
    expect(JSON.stringify(body.input)).toContain('JSON Schema')
    const result = protocolResponse('responses', capabilityFixture, body.stream)
    await route.fulfill({
      headers: { 'access-control-allow-origin': '*', 'content-type': result.contentType },
      body: result.body,
    })
  })
  await prepare(page)
  await selectProtocol(page, 'responses')
  await page.locator('form').getByRole('button', { name: '测试渠道', exact: true }).click()
  await expect(page.getByText(/测试通过 ·/)).toBeVisible()
  await expect(page.getByLabel('协议测试结果')).toContainText(
    '非流式 提示词 JSON · 流式 提示词 JSON',
  )
  expect(formats).toEqual([
    'json_schema',
    'json_object',
    undefined,
    'json_schema',
    'json_object',
    undefined,
  ])
})
