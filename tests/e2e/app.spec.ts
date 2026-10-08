import { test, expect, type Page } from '@playwright/test'
import {
  channelFixture,
  completion,
  compressionFixture,
  forumFixture,
  narrativeFixture,
  sse,
} from '../fixtures'

type Body = {
  model: string
  stream?: boolean
  response_format: { type: string; json_schema: { name: string; strict: boolean } }
  messages: { role: string; content: string }[]
}
async function prepare(
  page: Page,
  respond?: (body: Body) => { value: unknown; finish?: string; status?: number },
  seed: { historyTurns?: number; historyRepeats?: number; contextWindow?: number } = {},
) {
  const requests: Body[] = []
  await page.addInitScript((seed) => {
    if (localStorage.getItem('test-seeded')) return
    localStorage.setItem('test-seeded', 'true')
    localStorage.setItem(
      'yanju_archives',
      JSON.stringify([
        {
          id: 'archive-1',
          name: '阅读篇章',
          createdAt: 1,
          updatedAt: 2,
          messages: [
            {
              id: 'opening',
              role: 'assistant',
              content: '午后的书房很安静，今天想读哪一本书？',
              timestamp: 1,
            },
            ...Array.from({ length: (seed.historyTurns ?? 0) * 2 }, (_, i) => ({
              id: `history-${i}`,
              role: i % 2 ? 'assistant' : 'user',
              content: `旧历史${i}：${'讨论阅读和明天的安排。'.repeat(seed.historyRepeats ?? 1)}`,
              timestamp: i + 2,
            })),
          ],
        },
        {
          id: 'archive-2',
          name: '第二篇章',
          createdAt: 1,
          updatedAt: 1,
          messages: [
            { id: 'opening-2', role: 'assistant', content: '第二篇章的开场。', timestamp: 1 },
          ],
        },
      ]),
    )
    localStorage.setItem(
      'yanju_masks',
      JSON.stringify([
        {
          id: 'persona-1',
          name: '测试读者',
          gender: '其他',
          identity: '读者',
          prefer: '阅读',
          force: '不允许代替我说话。',
          createdAt: 1,
        },
      ]),
    )
    localStorage.setItem('yanju_archive_cur', JSON.stringify('archive-1'))
    localStorage.setItem('yanju_channel_cur', JSON.stringify('channel-1'))
    localStorage.setItem('yanju_mask_cur', JSON.stringify('persona-1'))
    localStorage.setItem(
      'yanju_channels',
      JSON.stringify([
        {
          id: 'channel-1',
          name: '测试渠道',
          baseUrl: 'https://mock.example/v1',
          apiKey: 'test-key-not-real',
          model: 'test-model',
          maxTokens: 4096,
          temperature: 0.9,
          contextWindow: seed.contextWindow ?? 131072,
          createdAt: 1,
        },
        {
          id: 'channel-2',
          name: '第二渠道',
          baseUrl: 'https://mock.example/v1',
          apiKey: 'test-key-not-real',
          model: 'second-model',
          maxTokens: 4096,
          temperature: 0.9,
          contextWindow: 131072,
          createdAt: 1,
        },
      ]),
    )
  }, seed)
  await page.route(`${channelFixture.baseUrl}/chat/completions`, async (route) => {
    const body = route.request().postDataJSON() as Body
    requests.push(body)
    const fallback =
      body.response_format.json_schema.name === 'ChannelCapability'
        ? { ready: true, echo: 'YanJu strict output' }
        : body.response_format.json_schema.name === 'ForumReply'
          ? forumFixture
          : body.response_format.json_schema.name === 'CompressionResult'
            ? compressionFixture
            : narrativeFixture
    const response = respond?.(body) ?? { value: fallback }
    await route.fulfill({
      status: response.status ?? 200,
      headers: {
        'access-control-allow-origin': '*',
        'content-type': body.stream ? 'text/event-stream' : 'application/json',
      },
      body:
        body.stream && !response.status
          ? sse(response.value, response.finish).join('')
          : JSON.stringify(response.status ? response.value : completion(response.value)),
    })
  })
  await page.goto('./')
  await expect(page.getByRole('button', { name: '进入聊天' })).toBeVisible()
  return requests
}
async function enableChannel(page: Page, name = '测试渠道') {
  await page.getByRole('button', { name: '渠道管理', exact: true }).click()
  await page
    .getByRole('navigation', { name: '渠道列表' })
    .getByRole('button', { name, exact: true })
    .click()
  await page.locator('fieldset').getByRole('button', { name: '测试渠道', exact: true }).click()
  await expect(page.getByText(/测试通过 ·/)).toBeVisible()
  await page.getByRole('button', { name: '使用此渠道' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
}
async function enter(page: Page) {
  await page.getByRole('button', { name: '进入聊天' }).click()
  await expect(page.getByRole('textbox', { name: '聊天输入' })).toBeVisible()
}

test('叙事、手机、日记、论坛和严格协议贯通', async ({ page }) => {
  const requests = await prepare(page)
  await enableChannel(page)
  await enter(page)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('一起读书吧。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('SCENE / 场景')).toBeVisible()
  await expect(page.getByRole('button', { name: /STATE \/ INTERNAL/ })).toBeVisible()
  await page.getByRole('button', { name: /DEVICE \/ INTERFACE/ }).click()
  await expect(page.getByRole('heading', { name: '备忘录' })).toBeVisible()
  await page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ }).click()
  await expect(page.getByText('距求婚还有 60 天')).toBeVisible()
  await page.getByRole('combobox', { name: '聊天模式' }).click()
  await page.getByRole('option', { name: '论坛', exact: true }).click()
  await page.getByRole('textbox', { name: '聊天输入' }).fill('今天该读什么书？')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('今天该读哪一本书？')).toBeVisible()
  await expect(page.getByText(/50\/50 回答/)).toBeVisible()
  await page.getByRole('button', { name: /展开更多回答/ }).click()
  await expect(page.getByText('读者20', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '回复', exact: true }).first().click()
  await page.getByRole('textbox', { name: '内容', exact: true }).fill('谢谢推荐。')
  await page.getByRole('dialog').getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => requests.filter((r) => r.stream).length).toBe(3)
  expect(
    requests.every(
      (r) => r.response_format.type === 'json_schema' && r.response_format.json_schema.strict,
    ),
  ).toBe(true)
  const history = requests.filter((r) => r.stream).at(-1)!.messages
  expect(history.some((m) => m.role === 'assistant' && m.content.includes('innerVoice'))).toBe(true)
  expect(history.some((m) => m.role === 'assistant' && m.content.includes('answer-49'))).toBe(true)
})

for (const mode of ['手动', '自动'] as const) {
  test(`${mode}压缩后可正常续聊，刷新后继续保留已发送前缀`, async ({ page }) => {
    const requests = await prepare(page, undefined, {
      historyTurns: 6,
      historyRepeats: mode === '自动' ? 650 : 1,
      contextWindow: mode === '自动' ? 65536 : 131072,
    })
    await enableChannel(page)
    await enter(page)
    if (mode === '手动') {
      await page.getByRole('button', { name: '压缩上下文', exact: true }).click()
      await expect(page.getByText('上下文压缩完成，原文保留。')).toBeVisible()
    }
    await page.getByRole('textbox', { name: '聊天输入' }).fill('压缩后继续一起读书。')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toBeVisible()
    await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
    expect(requests.some((r) => r.response_format.json_schema.name === 'CompressionResult')).toBe(
      true,
    )
    const before = requests.filter((r) => r.stream).at(-1)!
    expect(before.messages[1].role).toBe('system')
    expect(before.messages[1].content).toContain(JSON.stringify(compressionFixture))
    await expect(page.getByText(/^旧历史0：/)).toHaveCount(1)

    await page.reload()
    await page.getByRole('textbox', { name: '聊天输入' }).fill('明天继续阅读。')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toHaveCount(2)
    await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
    const after = requests.filter((r) => r.stream).at(-1)!
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages)
    expect(after.response_format).toEqual(before.response_format)
    await expect(page.getByText(/^旧历史0：/)).toHaveCount(1)
    await expect(page.getByText(/压缩未完成：/)).toHaveCount(0)
  })
}

test('纠正成功后刷新续聊，纠正请求仍保留在上下文前缀', async ({ page }) => {
  let narrativeRequests = 0
  const requests = await prepare(page, (body) => {
    if (body.response_format.json_schema.name === 'ChannelCapability')
      return { value: { ready: true, echo: 'YanJu strict output' } }
    narrativeRequests++
    return {
      value:
        narrativeRequests === 1
          ? { ...narrativeFixture, diary: { ...narrativeFixture.diary, text: '' } }
          : narrativeFixture,
    }
  })
  await enableChannel(page)
  await enter(page)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('一起阅读。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  expect(requests.filter((r) => r.stream)).toHaveLength(2)
  const corrected = requests.filter((r) => r.stream).at(-1)!
  expect(corrected.messages.at(-1)?.content).toContain('校验失败')

  await page.reload()
  await page.getByRole('textbox', { name: '聊天输入' }).fill('接着读。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toHaveCount(2)
  const next = requests.filter((r) => r.stream).at(-1)!
  expect(next.messages.slice(0, corrected.messages.length)).toEqual(corrected.messages)
  expect(next.response_format).toEqual(corrected.response_format)
})

test('渠道切换、存档链接、刷新和 v2 导入导出', async ({ page }) => {
  const requests = await prepare(page)
  await enableChannel(page)
  await enableChannel(page, '第二渠道')
  await enter(page)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('第二个模型。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect.poll(() => requests.filter((r) => r.stream).length).toBe(1)
  expect(requests.find((r) => r.stream)?.model).toBe('second-model')
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  await page.getByRole('button', { name: '存档管理' }).click()
  await page.getByRole('button', { name: '载入', exact: true }).click()
  await expect(page).toHaveURL(/#\/chat\/archive-2$/)
  await expect(page.getByText('第二篇章的开场。')).toBeVisible()
  await page.reload()
  await expect(page.getByText('第二篇章的开场。')).toBeVisible()
  await page.getByRole('button', { name: '存档管理' }).click()
  await page.getByRole('button', { name: '重命名 第二篇章' }).click()
  await page.getByRole('textbox', { name: '存档名称' }).fill('改名篇章')
  await page.getByRole('button', { name: '保存名称' }).click()
  await expect(page.getByText('改名篇章', { exact: true }).first()).toBeVisible()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出全部' }).click()
  const download = await downloadPromise
  const path = await download.path()
  expect(path).toBeTruthy()
  await page.getByLabel('导入存档文件').setInputFiles(path!)
  await page
    .getByRole('dialog', { name: '导入并替换当前资料？' })
    .getByRole('button', { name: '确认', exact: true })
    .click()
  await expect(page.getByText('存档导入完成。渠道须重新测试。')).toBeVisible()
  await expect(page.getByText('第二篇章的开场。')).toBeVisible()
  await expect(page.getByRole('combobox', { name: '当前渠道' })).toContainText('第二渠道')
})

test('中文输入法、换行、移动端宽度和触控尺寸', async ({ page }) => {
  const requests = await prepare(page)
  await enableChannel(page)
  await enter(page)
  const input = page.getByRole('textbox', { name: '聊天输入' })
  await input.fill('正在输入中文')
  await input.dispatchEvent('compositionstart')
  await input.dispatchEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    isComposing: true,
    keyCode: 229,
  })
  expect(requests.filter((r) => r.stream)).toHaveLength(0)
  await expect(input).toHaveValue('正在输入中文')
  await input.dispatchEvent('compositionend')
  await input.press('Shift+Enter')
  await expect(input).toHaveValue('正在输入中文\n')
  expect(requests.filter((r) => r.stream)).toHaveLength(0)
  await input.press('Enter')
  await expect.poll(() => requests.filter((r) => r.stream).length).toBe(1)
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const sizes = await page
    .getByRole('navigation', { name: '应用操作' })
    .getByRole('button')
    .evaluateAll((elements) =>
      elements.map((el) => ({
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height,
      })),
    )
  expect(sizes.every((s) => s.width >= 44 && s.height >= 44)).toBe(true)
  expect(
    await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(16)
})

test('截断保留收到的内容，并可重试', async ({ page }) => {
  let narrativeRequests = 0
  const requests = await prepare(page, (body) => {
    if (body.response_format.json_schema.name === 'ChannelCapability')
      return { value: { ready: true, echo: 'YanJu strict output' } }
    narrativeRequests++
    return narrativeRequests === 1
      ? {
          value: {
            scene: narrativeFixture.scene,
            blocks: [{ kind: 'narration', text: '可恢复的部分正文', translation: '' }],
          },
          finish: 'length',
        }
      : { value: narrativeFixture }
  })
  await enableChannel(page)
  await enter(page)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('继续阅读。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('可恢复的部分正文')).toBeVisible()
  await expect(page.getByRole('button', { name: '重试回复', exact: true })).toBeVisible()
  expect(requests.filter((r) => r.stream)).toHaveLength(1)
  await page.getByRole('button', { name: '重试回复', exact: true }).click()
  await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '重试回复', exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toBeVisible()
})

test('取消保存部分内容，停止后可继续聊天', async ({ page }) => {
  await prepare(page)
  await enableChannel(page)
  await enter(page)
  await page.evaluate(() => {
    const original = window.fetch.bind(window)
    window.fetch = async (url, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      if (!body?.stream) return original(url, init)
      const encoder = new TextEncoder()
      const partial = JSON.stringify({
        scene: { time: '2019年', location: '书房' },
        blocks: [{ kind: 'narration', text: '停止前收到的内容', translation: '' }],
      }).slice(0, -1)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ id: 'slow', created: 1, model: 'test-model', choices: [{ index: 0, delta: { content: partial }, finish_reason: null }] })}\n\n`,
              ),
            )
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('Cancelled', 'AbortError')),
            )
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
  })
  await page.getByRole('textbox', { name: '聊天输入' }).fill('慢一点。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('停止前收到的内容')).toBeVisible()
  await page.getByRole('button', { name: '停止生成' }).click()
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText('停止前收到的内容')).toBeVisible()
  await expect(page.getByRole('button', { name: '重试回复', exact: true })).toBeVisible()
})

test('不支持严格结构化的渠道不能用于聊天', async ({ page }) => {
  const requests = await prepare(page, () => ({
    status: 400,
    value: { error: { message: 'json_schema strict unsupported', type: 'invalid_request_error' } },
  }))
  await page.getByRole('button', { name: '渠道管理', exact: true }).click()
  await page.locator('fieldset').getByRole('button', { name: '测试渠道', exact: true }).click()
  await expect(page.getByRole('button', { name: '使用此渠道' })).toBeDisabled()
  await expect(page.getByText(/渠道未能完成严格结构化请求/).first()).toBeVisible()
  expect(requests).toHaveLength(1)
  expect(requests[0].response_format.type).toBe('json_schema')
})
