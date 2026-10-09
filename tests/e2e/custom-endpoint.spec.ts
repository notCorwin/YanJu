import { expect } from '@playwright/test'
import { test, expandChannel, openChannels } from './fixtures'
import { catalogFixture } from '../model-catalog-fixture'
import { capabilityFixture } from '../fixtures'
import { protocolResponse } from '../provider-protocol-fixtures'

test('Provider 首项选择自定义端点，跨目录选模型并独立选择协议与 SDK，刷新后保留配置', async ({
  page,
}) => {
  const catalog = catalogFixture()
  const model = catalog.mock.models['test-model']
  await page.route('https://models.dev/api.json', (route) =>
    route.fulfill({
      json: {
        ...catalog,
        azure: {
          ...catalog.mock,
          id: 'azure',
          name: '云端模型资料',
          npm: '@ai-sdk/azure',
          api: 'https://${AZURE_RESOURCE_NAME}.openai.azure.com/v1',
          env: ['AZURE_RESOURCE_NAME', 'AZURE_API_KEY'],
          models: {
            'test-model': {
              ...model,
              name: '云端同名模型',
              provider: { npm: '@ai-sdk/amazon-bedrock/mantle', shape: 'responses' },
              limit: { context: 262144, output: 128000 },
            },
          },
        },
      },
    }),
  )
  const calls: string[] = []
  await page.route('https://custom-gateway.example/**', async (route) => {
    const request = route.request()
    const url = request.url()
    const body = request.postDataJSON()
    calls.push(url)
    expect(request.headers().authorization).toBe('Bearer gateway-test-key')
    expect(request.headers()['api-key']).toBeUndefined()
    expect(url).not.toContain('api-version')
    expect(body.model).toBe('test-model')
    const result = protocolResponse(
      url.endsWith('/responses') ? 'responses' : 'chat-completions',
      capabilityFixture,
      body.stream,
    )
    await route.fulfill({
      headers: { 'access-control-allow-origin': '*', 'content-type': result.contentType },
      body: result.body,
    })
  })
  await page.goto('./')
  await openChannels(page)
  await page.getByRole('button', { name: '新建渠道', exact: true }).click()
  await expandChannel(page, '新渠道')
  const providerSelect = page.getByRole('combobox', { name: 'Provider', exact: true })
  await expect(providerSelect).toBeEnabled()
  await expect(page.getByRole('combobox', { name: '连接方式', exact: true })).toHaveCount(0)
  await providerSelect.click()
  await expect(page.getByRole('option').first()).toHaveText('自定义端点')
  await page.getByRole('option', { name: '自定义端点', exact: true }).click()
  await expect(providerSelect).toHaveText('自定义端点')
  const modelSelect = page.getByRole('combobox', { name: '模型', exact: true })
  await expect(modelSelect).toBeEnabled()
  await modelSelect.click()
  await page.getByRole('combobox', { name: '搜索模型', exact: true }).fill('test-model')
  await expect(page.getByRole('option')).toHaveCount(2)
  await page
    .getByRole('option', { name: 'test-model · test-model · 测试 Provider', exact: true })
    .click()
  await page.getByLabel('API Key', { exact: true }).fill('gateway-test-key')
  await page.getByRole('button', { name: '保存渠道', exact: true }).click()
  await expect(page.getByText('自定义端点需要填写 Base URL。', { exact: true })).toBeVisible()
  const baseUrl = page.getByLabel('Base URL', { exact: true })
  await baseUrl.fill('https://custom-gateway.example/v1/responses')
  const endpoint = page.getByRole('combobox', { name: 'API 端点', exact: true })
  await endpoint.click()
  await page.getByRole('option', { name: '/v1/responses', exact: true }).click()
  await modelSelect.click()
  await page.getByRole('combobox', { name: '搜索模型', exact: true }).fill('azure test-model')
  await page
    .getByRole('option', { name: '云端同名模型 · test-model · 云端模型资料', exact: true })
    .click()
  await expect(baseUrl).toHaveValue('https://custom-gateway.example/v1/responses')
  await expect(endpoint).toHaveText('/v1/responses')
  await expect(page.getByText(/上下文 262,144 tokens/)).toBeVisible()
  await page.locator('form').getByRole('button', { name: '测试渠道', exact: true }).click()
  await expect(page.getByText(/测试通过 ·/)).toBeVisible()
  await expect(page.getByRole('button', { name: '使用此渠道', exact: true })).toBeEnabled()
  expect(calls).toEqual(Array(2).fill('https://custom-gateway.example/v1/responses'))
  await page
    .getByRole('dialog', { name: '渠道管理', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  await page.reload()
  await openChannels(page)
  await expect(providerSelect).toHaveText('自定义端点')
  await expect(page.getByRole('combobox', { name: '连接方式', exact: true })).toHaveCount(0)
  await expect(modelSelect).toHaveText('云端同名模型 · test-model · 云端模型资料')
  await expect(baseUrl).toHaveValue('https://custom-gateway.example/v1/responses')
  await expect(page.getByRole('button', { name: '使用此渠道', exact: true })).toBeEnabled()
  await endpoint.click()
  await page.getByRole('option', { name: 'Provider SDK 默认端点', exact: true }).click()
  await page.getByRole('combobox', { name: 'Provider SDK', exact: true }).click()
  await page.getByRole('option', { name: '@ai-sdk/openai-compatible', exact: true }).click()
  await page.locator('form').getByRole('button', { name: '测试渠道', exact: true }).click()
  await expect(page.getByText(/测试通过 ·/)).toBeVisible()
  expect(calls.slice(-2)).toEqual(
    Array(2).fill('https://custom-gateway.example/v1/chat/completions'),
  )
  await providerSelect.click()
  await page.getByRole('option', { name: '测试 Provider', exact: true }).click()
  await expect(providerSelect).toHaveText('测试 Provider')
  await expect(modelSelect).toHaveText('test-model · test-model')
  await expect(page.getByLabel('Base URL（可选）', { exact: true })).toHaveValue('')
  await expect(page.getByRole('button', { name: '使用此渠道', exact: true })).toBeDisabled()
  await providerSelect.click()
  await page.getByRole('option', { name: '自定义端点', exact: true }).click()
  await expect(modelSelect).toHaveText('test-model · test-model · 测试 Provider')
})
