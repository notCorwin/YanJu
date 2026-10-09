import { expect, type Page } from '@playwright/test'
import { test, expandChannel, openChannels } from './fixtures'
import { catalogFixture } from '../model-catalog-fixture'

async function openChannelEditor(page: Page) {
  const catalog = catalogFixture()
  const model = catalog.mock.models['test-model']
  await page.route('https://models.dev/api.json', (route) =>
    route.fulfill({
      json: {
        ...catalog,
        stellar: {
          ...catalog.mock,
          id: 'stellar',
          name: '星河平台',
          models: {
            'stellar-chat-v2': { ...model, id: 'stellar-chat-v2', name: '夜航助手' },
            'stellar-pro-v1': {
              ...model,
              id: 'stellar-pro-v1',
              name: '晨曦写手',
              limit: { context: 262144 },
            },
            ...Object.fromEntries(
              Array.from({ length: 20 }, (_, index) => [
                `stellar-extra-${index}`,
                { ...model, id: `stellar-extra-${index}`, name: `额外模型 ${index}` },
              ]),
            ),
          },
        },
      },
    }),
  )
  await page.goto('./')
  await openChannels(page)
  await page.getByRole('button', { name: '新建渠道', exact: true }).click()
  await expandChannel(page, '新渠道')
  const provider = page.getByRole('combobox', { name: 'Provider', exact: true })
  await expect(provider).toBeEnabled()
  return provider
}

test('提供商按名称和 ID 搜索，关闭后恢复完整列表与焦点', async ({ page }) => {
  const provider = await openChannelEditor(page)
  await provider.click()
  const search = page.getByRole('combobox', { name: '搜索提供商', exact: true })
  await expect(search).toBeFocused()
  await expect(page.getByRole('option')).toHaveCount(2)
  await search.fill('不存在的提供商')
  await expect(page.getByRole('option')).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: '未找到匹配的提供商。' })).toBeVisible()
  await search.fill('  STELLAR  ')
  await expect(page.getByRole('option')).toHaveCount(1)
  await expect(page.getByRole('option', { name: '星河平台', exact: true })).toBeVisible()
  await search.fill('星河')
  await page.getByRole('option', { name: '星河平台', exact: true }).click()
  await expect(provider).toHaveText('星河平台')
  await expect(provider).toBeFocused()
  await expect(page.getByRole('combobox', { name: '模型', exact: true })).toHaveText(
    '夜航助手 · stellar-chat-v2',
  )

  await provider.press('ArrowDown')
  await expect(search).toHaveValue('')
  await expect(search).toBeFocused()
  await expect(page.getByRole('option')).toHaveCount(2)
  await search.fill('MOCK')
  await expect(page.getByRole('option')).toHaveCount(1)
  await search.press('Escape')
  await expect(search).toHaveCount(0)
  await expect(provider).toBeFocused()
  await expect(provider).toHaveText('星河平台')
  await expect(page.getByRole('dialog', { name: '渠道管理', exact: true })).toBeVisible()

  await provider.press('Enter')
  await search.fill('测试')
  await expect(page.getByRole('option', { name: '测试 Provider', exact: true })).toBeVisible()
  await search.press('Enter')
  await expect(provider).toHaveText('测试 Provider')
  await expect(page.getByRole('combobox', { name: '模型', exact: true })).toHaveText(
    'test-model · test-model',
  )
})

test('模型支持名称与 ID 搜索、键盘选择，搜索不会修改已保存配置', async ({ page }) => {
  const provider = await openChannelEditor(page)
  await provider.click()
  await page.getByRole('option', { name: '星河平台', exact: true }).click()
  const model = page.getByRole('combobox', { name: '模型', exact: true })
  await model.click()
  const search = page.getByRole('combobox', { name: '搜索模型', exact: true })
  await expect(search).toBeFocused()
  await expect(page.getByRole('option')).toHaveCount(22)
  const popup = page.getByRole('dialog', { name: '搜索模型', exact: true })
  const bounds = await popup.boundingBox()
  const viewport = page.viewportSize()!
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height)

  await search.fill('没有这个模型')
  await expect(page.getByRole('option')).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: '未找到匹配的模型。' })).toBeVisible()
  await search.press('Enter')
  await expect(search).toBeVisible()
  await expect(model).toHaveText('夜航助手 · stellar-chat-v2')
  await search.fill('晨曦')
  await expect(page.getByRole('option')).toHaveCount(1)
  await search.fill('晨曦 STELLAR-PRO')
  await expect(page.getByRole('option')).toHaveCount(1)
  await search.press('Enter')
  await expect(model).toHaveText('晨曦写手 · stellar-pro-v1')
  await expect(model).toBeFocused()
  await expect(page.getByText(/上下文 262,144 tokens/)).toBeVisible()

  await model.press('ArrowDown')
  await expect(search).toHaveValue('')
  await expect(page.getByRole('option')).toHaveCount(22)
  await search.fill('v')
  await expect(page.getByRole('option')).toHaveCount(2)
  const highlighted = page.getByRole('option', { selected: true })
  const initial = await highlighted.innerText()
  const next = (await page.getByRole('option').allTextContents()).find((text) => text !== initial)!
  await search.press('ArrowDown')
  await expect(highlighted).toHaveText(next)
  await search.press('ArrowUp')
  await expect(highlighted).toHaveText(initial)
  await search.press('Enter')
  await expect(model).toHaveText(initial)
  await model.click()
  await search.fill('  STELLAR-CHAT-V2  ')
  await expect(page.getByRole('option')).toHaveCount(1)
  await page.getByRole('option', { name: '夜航助手 · stellar-chat-v2', exact: true }).click()
  await expect(model).toHaveText('夜航助手 · stellar-chat-v2')
  await page.getByLabel('API Key', { exact: true }).fill('test-key')
  await page.getByRole('button', { name: '保存渠道', exact: true }).click()
  await expect(page.getByText('渠道已保存；通过测试后可用于聊天。')).toBeVisible()

  await model.click()
  await search.fill('晨曦')
  await search.press('Escape')
  await expect(model).toHaveText('夜航助手 · stellar-chat-v2')
  await model.click()
  await search.fill('STELLAR-CHAT-V2')
  await search.press('Enter')
  await page
    .getByRole('dialog', { name: '渠道管理', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.reload()
  await openChannels(page)
  await expect(model).toHaveText('夜航助手 · stellar-chat-v2')
})
