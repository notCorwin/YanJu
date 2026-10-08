import { expect, type Page } from '@playwright/test'
import { test } from './fixtures'
import { readFile } from 'node:fs/promises'
import {
  capabilityFixture,
  channelFixture,
  completion,
  compressionFixture,
  forumFixture,
  narrativeFixture,
  response,
  responseSse,
  sse,
} from '../fixtures'
import type { SaveFile } from '../../src/lib/types'

async function readOpfs(page: Page): Promise<SaveFile | undefined> {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory()
      const directory = await root.getDirectoryHandle('yanju-v2')
      const handle = await directory.getFileHandle('save.json')
      const raw = JSON.parse(await (await handle.getFile()).text())
      if (raw.format !== 'yanju-opfs-3') return raw
      const messages = await Promise.all(
        raw.messages.map(async (ref: { id: string; archiveId: string; file: string }) => {
          const message = JSON.parse(
            await (await (await directory.getFileHandle(ref.file)).getFile()).text(),
          )
          return {
            ...message,
            id: ref.id,
            archiveId: ref.archiveId,
            content:
              message.content ??
              JSON.stringify(message.reply?.value ?? message.partial?.value ?? ''),
          }
        }),
      )
      const bgImage = raw.backgroundFile
        ? await (await (await directory.getFileHandle(raw.backgroundFile)).getFile()).text()
        : ''
      return { ...raw.data, messages, settings: { ...raw.data.settings, bgImage } }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return undefined
      throw error
    }
  })
}

function lastSavedMessage(data: SaveFile | undefined) {
  return data?.messages
    .filter((message) => message.archiveId === 'archive-1')
    .sort((a, b) => a.sequence - b.sequence)
    .at(-1)
}

async function expectArchiveAvailable(page: Page) {
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  await page.getByRole('button', { name: '存档管理' }).click()
  await expect(page.getByRole('button', { name: '当前存档', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '载入', exact: true }).first()).toBeEnabled()
  await expect(page.getByRole('button', { name: '导出全部', exact: true })).toBeEnabled()
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
}

type Body = {
  model: string
  stream?: boolean
  response_format: { type: string; json_schema: { name: string; strict: boolean } }
  messages: { role: string; content: string }[]
}
const businessRequests = (requests: Body[]) =>
  requests.filter((r) => r.stream && r.response_format.json_schema.name !== 'ChannelCapability')
type ResponseBody = {
  model: string
  stream?: boolean
  input: { role: string; content: string | { type: string; text: string }[] }[]
  text: { format: { type: string; name: string; strict: boolean } }
  store: boolean
  temperature?: number
  max_output_tokens: number
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
          apiMode: 'chat-completions',
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
          apiMode: 'chat-completions',
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
        'access-control-expose-headers': 'x-request-id',
        'x-request-id': 'mock-request',
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
async function enableChannel(
  page: Page,
  name = '测试渠道',
  options?: { mode?: 'auto' | 'responses' | 'chat-completions'; defaultTemperature?: boolean },
) {
  await page.getByRole('button', { name: '渠道管理', exact: true }).click()
  await page
    .getByRole('navigation', { name: '渠道列表' })
    .getByRole('button', { name, exact: true })
    .click()
  if (options?.mode) {
    await page.getByRole('combobox', { name: 'API 协议' }).click()
    const label = {
      auto: '自动探测（Responses 优先）',
      responses: 'Responses',
      'chat-completions': 'Chat Completions',
    }[options.mode]
    await page.getByRole('option', { name: label, exact: true }).click()
  }
  if (options?.defaultTemperature) {
    await page.getByRole('combobox', { name: '温度设置' }).click()
    await page.getByRole('option', { name: '模型默认', exact: true }).click()
  }
  await page.locator('fieldset').getByRole('button', { name: '测试渠道', exact: true }).click()
  await expect(page.getByText(/测试通过 ·/)).toBeVisible()
  await page.getByRole('button', { name: '使用此渠道' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
}
async function prepareResponses(
  page: Page,
  respond?: (body: ResponseBody) => { value: unknown; terminal?: string; reason?: string },
) {
  const chatRequests = await prepare(page)
  const requests: ResponseBody[] = []
  await page.route(`${channelFixture.baseUrl}/responses`, async (route) => {
    const body = route.request().postDataJSON() as ResponseBody
    requests.push(body)
    const name = body.text.format.name
    const fallback =
      name === 'ChannelCapability'
        ? capabilityFixture
        : name === 'CompressionResult'
          ? compressionFixture
          : name === 'ForumReply'
            ? forumFixture
            : narrativeFixture
    const result = respond?.(body) ?? { value: fallback }
    await route.fulfill({
      headers: {
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'x-request-id',
        'x-request-id': 'mock-request',
        'content-type': body.stream ? 'text/event-stream' : 'application/json',
      },
      body: body.stream
        ? responseSse(result.value, result.terminal, result.reason).join('')
        : JSON.stringify(response(result.value)),
    })
  })
  return { requests, chatRequests }
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
  await expectArchiveAvailable(page)
  expect(lastSavedMessage(await readOpfs(page))?.reply).toEqual({
    kind: 'narrative',
    value: narrativeFixture,
  })
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
  await expectArchiveAvailable(page)
  expect(lastSavedMessage(await readOpfs(page))?.reply).toEqual({
    kind: 'forum',
    value: forumFixture,
  })
  await page.getByRole('button', { name: /展开更多回答/ }).click()
  await expect(page.getByText('读者20', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '回复', exact: true }).first().click()
  await page.getByRole('textbox', { name: '内容', exact: true }).fill('谢谢推荐。')
  await page.getByRole('dialog').getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => businessRequests(requests).length).toBe(3)
  await expectArchiveAvailable(page)
  expect((await readOpfs(page))?.messages.filter((m) => m.reply).length).toBe(3)
  expect(
    requests.every(
      (r) => r.response_format.type === 'json_schema' && r.response_format.json_schema.strict,
    ),
  ).toBe(true)
  const history = businessRequests(requests).at(-1)!.messages
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
    const before = businessRequests(requests).at(-1)!
    expect(before.messages[1].role).toBe('system')
    expect(before.messages[1].content).toContain(JSON.stringify(compressionFixture))
    await expect(page.getByText(/^旧历史0：/)).toHaveCount(1)

    await page.reload()
    await page.getByRole('textbox', { name: '聊天输入' }).fill('明天继续阅读。')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toHaveCount(2)
    await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
    const after = businessRequests(requests).at(-1)!
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
  expect(businessRequests(requests)).toHaveLength(2)
  const corrected = businessRequests(requests).at(-1)!
  expect(corrected.messages.at(-1)?.content).toContain('校验失败')

  await page.reload()
  await page.getByRole('textbox', { name: '聊天输入' }).fill('接着读。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toHaveCount(2)
  const next = businessRequests(requests).at(-1)!
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
  await expect.poll(() => businessRequests(requests).length).toBe(1)
  expect(businessRequests(requests)[0]?.model).toBe('second-model')
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  await page.getByRole('button', { name: '存档管理' }).click()
  await page.getByRole('button', { name: '载入', exact: true }).first().click()
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
  expect(businessRequests(requests)).toHaveLength(0)
  await expect(input).toHaveValue('正在输入中文')
  await input.dispatchEvent('compositionend')
  await input.press('Shift+Enter')
  await expect(input).toHaveValue('正在输入中文\n')
  expect(businessRequests(requests)).toHaveLength(0)
  await input.press('Enter')
  await expect.poll(() => businessRequests(requests).length).toBe(1)
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
  await expectArchiveAvailable(page)
  expect(lastSavedMessage(await readOpfs(page))).toMatchObject({
    status: 'failed',
    partial: { kind: 'narrative', value: { blocks: [{ text: '可恢复的部分正文' }] } },
  })
  expect(businessRequests(requests)).toHaveLength(1)
  await page.getByRole('button', { name: '重试回复', exact: true }).click()
  await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '重试回复', exact: true })).toHaveCount(0)
  await expectArchiveAvailable(page)
  expect(lastSavedMessage(await readOpfs(page))?.status).toBe('complete')
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
  await expectArchiveAvailable(page)
  expect(lastSavedMessage(await readOpfs(page))?.status).toBe('cancelled')
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

test('只保留 OPFS 文件时仍恢复完整聊天、草稿、人设与已测试渠道', async ({ page, context }) => {
  await prepare(page)
  await enableChannel(page)
  await enter(page)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('验证 OPFS 恢复。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expectArchiveAvailable(page)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('未发送的草稿')
  await expect
    .poll(async () => (await readOpfs(page))?.archives.find((a) => a.id === 'archive-1')?.draft)
    .toBe('未发送的草稿')
  await page.goto('about:blank')

  const recovered = await context.newPage()
  await recovered.route('**/storage-reset', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>存储恢复测试</title>' }),
  )
  await recovered.goto('./storage-reset')
  await recovered.evaluate(async () => {
    localStorage.clear()
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('yanju-v2')
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('工作数据库仍有连接'))
    })
  })
  await recovered.goto('./#/chat/archive-1')
  await expect(recovered.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toBeVisible()
  await expect(recovered.getByRole('textbox', { name: '聊天输入' })).toHaveValue('未发送的草稿')
  await expect(recovered.getByRole('combobox', { name: '当前渠道' })).toContainText('测试渠道')
  await expect(recovered.getByText('宴雎 / 测试读者', { exact: true })).toBeVisible()
  await expectArchiveAvailable(recovered)
  expect(lastSavedMessage(await readOpfs(recovered))?.reply?.value).toEqual(narrativeFixture)
})

test('OPFS 写入失败后存档仍可载入和导出，并可重试同步', async ({ page }) => {
  await prepare(page)
  await enableChannel(page)
  await enter(page)
  await page.evaluate(() => {
    const original = FileSystemFileHandle.prototype.createWritable
    let failing = true
    FileSystemFileHandle.prototype.createWritable = function (...args) {
      if (failing) return Promise.reject(new DOMException('测试磁盘已满', 'QuotaExceededError'))
      return original.apply(this, args)
    }
    Object.defineProperty(window, 'allowOpfsWrites', {
      value: () => {
        failing = false
      },
    })
  })
  await page.getByRole('textbox', { name: '聊天输入' }).fill('磁盘错误后仍可存档。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expectArchiveAvailable(page)
  await page.getByRole('button', { name: '存档管理' }).click()
  await expect(page.getByText(/OPFS 同步失败：测试磁盘已满/)).toBeVisible()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出全部' }).click()
  const downloaded = await downloadPromise
  const stream = await downloaded.createReadStream()
  const bytes = []
  for await (const chunk of stream!) bytes.push(chunk)
  const exported = JSON.parse(Buffer.concat(bytes).toString()) as SaveFile
  expect(lastSavedMessage(exported)?.status).toBe('complete')
  expect(lastSavedMessage(exported)?.reply?.value).toEqual(narrativeFixture)
  await page.evaluate(() =>
    (window as typeof window & { allowOpfsWrites: () => void }).allowOpfsWrites(),
  )
  await page.getByRole('button', { name: '重试存档同步' }).click()
  await expect(page.getByText(/已同步 OPFS 存档/)).toBeVisible()
  expect(lastSavedMessage(await readOpfs(page))?.reply?.value).toEqual(narrativeFixture)
  await page.getByRole('button', { name: '载入', exact: true }).first().click()
  await expect(page.getByText('第二篇章的开场。')).toBeVisible()
})

test('没有部分内容的模型错误结束后仍可管理和导出存档', async ({ page }) => {
  await prepare(page, (body) =>
    body.response_format.json_schema.name === 'ChannelCapability'
      ? { value: { ready: true, echo: 'YanJu strict output' } }
      : { status: 401, value: { error: { message: '模型凭据无效', type: 'invalid_api_key' } } },
  )
  await enableChannel(page)
  await enter(page)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('验证失败后的存档。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: '重试回复', exact: true })).toBeVisible()
  await expectArchiveAvailable(page)
  expect(lastSavedMessage(await readOpfs(page))?.status).toBe('failed')
})

test('自动优先 Responses，叙事、论坛、摘要续聊及 v2 存档往返', async ({ page }) => {
  test.setTimeout(60000)
  const { requests, chatRequests } = await prepareResponses(page)
  await enableChannel(page, '测试渠道', { mode: 'auto', defaultTemperature: true })
  expect(requests).toHaveLength(2)
  expect(chatRequests).toHaveLength(2)
  await enter(page)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('一起读书吧。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  await page.getByRole('button', { name: '压缩上下文', exact: true }).click()
  await expect(page.getByText('上下文压缩完成，原文保留。')).toBeVisible()
  expect(requests.filter((r) => r.text.format.name === 'CompressionResult')).toHaveLength(1)
  await page.getByRole('combobox', { name: '聊天模式' }).click()
  await page.getByRole('option', { name: '论坛', exact: true }).click()
  await page.getByRole('textbox', { name: '聊天输入' }).fill('今天该读什么书？')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText(/50\/50 回答/)).toBeVisible()
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText(/50\/50 回答/)).toBeVisible()
  await page.getByRole('textbox', { name: '聊天输入' }).fill('接着刚才的话题。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect
    .poll(
      () => requests.filter((r) => r.stream && r.text.format.name !== 'ChannelCapability').length,
    )
    .toBe(3)
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  const history = JSON.stringify(requests.at(-1)!.input)
  expect(history).toContain('innerVoice')
  expect(history).toContain('answer-49')
  expect(history).toContain(compressionFixture.summary)
  expect(
    requests.every(
      (r) =>
        r.text.format.type === 'json_schema' &&
        r.text.format.strict &&
        r.store === false &&
        !('temperature' in r),
    ),
  ).toBe(true)
  expect(chatRequests).toHaveLength(2)
  await page.getByRole('button', { name: '渠道管理', exact: true }).click()
  await expect(page.getByText(/当前协议：Responses/)).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'API 协议' })).toContainText('自动探测')
  await expect(page.getByRole('combobox', { name: '温度设置' })).toContainText('模型默认')
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: '存档管理' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出全部' }).click()
  const path = await (await downloadPromise).path()
  const exported = JSON.parse(await readFile(path!, 'utf8'))
  expect(exported.version).toBe(2)
  expect(exported.channels.find((c: { id: string }) => c.id === 'channel-1')).toMatchObject({
    apiMode: 'auto',
    temperature: null,
  })
  await page.getByLabel('导入存档文件').setInputFiles(path!)
  await page
    .getByRole('dialog', { name: '导入并替换当前资料？' })
    .getByRole('button', { name: '确认', exact: true })
    .click()
  await expect(page.getByText('存档导入完成。渠道须重新测试。')).toBeVisible()
  await page.getByRole('button', { name: '渠道管理', exact: true }).click()
  await expect(page.getByRole('button', { name: '使用此渠道' })).toBeDisabled()
  await expect(page.getByRole('combobox', { name: 'API 协议' })).toContainText('自动探测')
  await expect(page.getByRole('combobox', { name: '温度设置' })).toContainText('模型默认')
})

test('手动协议、取消重测保留结果，配置修改使缓存失效', async ({ page }) => {
  const { requests, chatRequests } = await prepareResponses(page)
  await enableChannel(page, '测试渠道', { mode: 'responses' })
  expect(requests).toHaveLength(2)
  expect(chatRequests).toHaveLength(0)
  await page.getByRole('button', { name: '渠道管理', exact: true }).click()
  let pending = false
  let release = () => {}
  await page.route(`${channelFixture.baseUrl}/responses`, async (route) => {
    pending = true
    await new Promise<void>((resolve) => {
      release = resolve
    })
    await route.fulfill({ json: response(capabilityFixture) }).catch(() => {})
  })
  await page.locator('fieldset').getByRole('button', { name: '测试渠道', exact: true }).click()
  await expect.poll(() => pending).toBe(true)
  await expect(page.getByRole('status').filter({ hasText: /正在测试 Responses/ })).toBeVisible()
  await page.getByRole('button', { name: '取消测试', exact: true }).click()
  await expect(page.getByText('渠道测试已取消，原测试结果已保留。')).toBeVisible()
  release()
  await expect(page.getByRole('button', { name: '使用此渠道' })).toBeEnabled()
  await expect(page.getByText(/当前协议：Responses/)).toBeVisible()
  await page.getByRole('combobox', { name: 'API 协议' }).click()
  await page.getByRole('option', { name: 'Chat Completions', exact: true }).click()
  await expect(page.getByRole('button', { name: '使用此渠道' })).toBeDisabled()
  await expect(page.getByText(/当前协议：Responses/)).toHaveCount(0)
  await page.locator('fieldset').getByRole('button', { name: '测试渠道', exact: true }).click()
  await expect(page.getByText(/当前协议：Chat Completions/)).toBeVisible()
  await page.getByRole('button', { name: '使用此渠道' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await enter(page)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('切换协议后继续。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect.poll(() => businessRequests(chatRequests).length).toBe(1)
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  await page.reload()
  await page.getByRole('button', { name: '渠道管理', exact: true }).click()
  await expect(page.getByText(/当前协议：Chat Completions/)).toBeVisible()
  await page.getByRole('textbox', { name: '模型', exact: true }).fill('new-model')
  await expect(page.getByRole('button', { name: '使用此渠道' })).toBeDisabled()
})

for (const action of ['修改', '删除']) {
  test(`测试全部期间其他标签页${action}渠道，不覆盖配置或复活记录`, async ({ page, context }) => {
    await prepare(page)
    await enableChannel(page)
    const other = await context.newPage()
    await other.goto('./')
    await other.getByRole('button', { name: '渠道管理', exact: true }).click()
    await other
      .getByRole('navigation', { name: '渠道列表' })
      .getByRole('button', { name: '测试渠道', exact: true })
      .click()
    await page.getByRole('button', { name: '渠道管理', exact: true }).click()
    let pending = false
    let held = false
    let release = () => {}
    await page.route(`${channelFixture.baseUrl}/chat/completions`, async (route) => {
      if (!held) {
        held = true
        pending = true
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      await route.fallback()
    })
    await page.getByRole('button', { name: '测试全部', exact: true }).click()
    await expect.poll(() => pending).toBe(true)
    if (action === '修改') {
      await other
        .getByRole('textbox', { name: '模型', exact: true })
        .fill('new-model-from-other-tab')
      await other.getByRole('button', { name: '保存渠道', exact: true }).click()
      await expect(other.getByText('渠道已保存；通过测试后可用于聊天。')).toBeVisible()
    } else {
      await other.getByRole('button', { name: '删除渠道', exact: true }).click()
      await other
        .getByRole('dialog', { name: '删除渠道？' })
        .getByRole('button', { name: '确认', exact: true })
        .click()
      await expect(
        other
          .getByRole('navigation', { name: '渠道列表' })
          .getByRole('button', { name: '测试渠道', exact: true }),
      ).toHaveCount(0)
    }
    release()
    await expect(
      page.getByText('渠道测试已结束；1 个渠道配置已变更或删除，旧测试结果未保存。请重新测试。'),
    ).toBeVisible()
    await other.reload()
    await other.getByRole('button', { name: '渠道管理', exact: true }).click()
    if (action === '修改') {
      await other
        .getByRole('navigation', { name: '渠道列表' })
        .getByRole('button', { name: '测试渠道', exact: true })
        .click()
      await expect(other.getByRole('textbox', { name: '模型', exact: true })).toHaveValue(
        'new-model-from-other-tab',
      )
      await expect(other.getByRole('button', { name: '使用此渠道', exact: true })).toBeDisabled()
    } else {
      await expect(
        other
          .getByRole('navigation', { name: '渠道列表' })
          .getByRole('button', { name: '测试渠道', exact: true }),
      ).toHaveCount(0)
    }
  })
}

for (const terminal of ['incomplete', 'missing']) {
  test(`Responses ${terminal} 保留部分对象并支持刷新重试`, async ({ page }) => {
    let generations = 0
    const { requests } = await prepareResponses(page, (body) => {
      if (body.text.format.name === 'ChannelCapability') return { value: capabilityFixture }
      generations++
      return generations === 1
        ? {
            value: {
              ...narrativeFixture,
              blocks: [{ kind: 'narration', text: 'Responses 部分正文', translation: '' }],
            },
            terminal,
            reason: terminal === 'incomplete' ? 'max_output_tokens' : undefined,
          }
        : { value: narrativeFixture }
    })
    await enableChannel(page, '测试渠道', { mode: 'responses' })
    await enter(page)
    await page.getByRole('textbox', { name: '聊天输入' }).fill('继续阅读。')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByText('Responses 部分正文')).toBeVisible()
    await expect(page.getByRole('button', { name: '重试回复', exact: true })).toBeVisible()
    await expect(
      page.getByText(terminal === 'incomplete' ? /回复达到输出上限/ : /未返回完整终止事件/).first(),
    ).toBeVisible()
    expect(generations).toBe(1)
    await page.reload()
    await expect(page.getByText('Responses 部分正文')).toBeVisible()
    await page.getByRole('button', { name: '重试回复', exact: true }).click()
    await expect(page.getByRole('button', { name: '重试回复', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toBeVisible()
    expect(requests.filter((r) => r.text.format.name === 'NarrativeReply')).toHaveLength(2)
  })
}

test('Responses 停止保存部分内容，刷新后继续使用选定协议', async ({ page }) => {
  const { requests } = await prepareResponses(page)
  await enableChannel(page, '测试渠道', { mode: 'responses' })
  await enter(page)
  const chunks = responseSse(
    {
      scene: narrativeFixture.scene,
      blocks: [{ kind: 'narration', text: 'Responses 停止前的内容', translation: '' }],
    },
    'missing',
  ).slice(0, -1)
  await page.evaluate((frames) => {
    const original = window.fetch.bind(window)
    window.fetch = async (url, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      if (!body?.stream) return original(url, init)
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const frame of frames) controller.enqueue(encoder.encode(frame))
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('Cancelled', 'AbortError')),
            )
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
  }, chunks)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('慢一点。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('Responses 停止前的内容')).toBeVisible()
  await page.getByRole('button', { name: '停止生成' }).click()
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText('Responses 停止前的内容')).toBeVisible()
  await page.getByRole('button', { name: '重试回复', exact: true }).click()
  await expect(page.getByRole('button', { name: '重试回复', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toBeVisible()
  expect(requests.filter((r) => r.text.format.name === 'NarrativeReply')).toHaveLength(1)
})

test('完整协议能力测试覆盖真实流式结构，不写入聊天存档', async ({ page }) => {
  const requests = await prepare(page)
  await page.getByRole('button', { name: '渠道管理', exact: true }).click()
  await page.getByRole('button', { name: '完整协议测试', exact: true }).click()
  await expect(page.getByText(/测试通过 · 完整协议/)).toBeVisible()
  expect(requests.map((body) => body.response_format.json_schema.name)).toEqual([
    'ChannelCapability',
    'ChannelCapability',
    'NarrativeReply',
    'ForumReply',
    'CompressionResult',
  ])
  expect(requests.filter((body) => body.stream)).toHaveLength(3)
  await page.getByRole('button', { name: '使用此渠道' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await enter(page)
  await expect(page.getByRole('button', { name: '编辑消息', exact: true })).toHaveCount(1)
})

test('自动选定 Responses 后完整协议测试仍覆盖叙事论坛摘要并保留诊断', async ({ page }) => {
  const { requests, chatRequests } = await prepareResponses(page)
  await page.getByRole('button', { name: '渠道管理', exact: true }).click()
  await page.getByRole('combobox', { name: 'API 协议' }).click()
  await page.getByRole('option', { name: '自动探测（Responses 优先）', exact: true }).click()
  await page.getByRole('button', { name: '完整协议测试', exact: true }).click()
  await expect(page.getByText(/测试通过 · 完整协议/)).toBeVisible()
  await expect(page.getByText(/当前协议：Responses/)).toBeVisible()
  expect(requests.map((body) => body.text.format.name)).toEqual([
    'ChannelCapability',
    'ChannelCapability',
    'NarrativeReply',
    'ForumReply',
    'CompressionResult',
  ])
  expect(chatRequests).toHaveLength(2)
  expect(requests.every((body) => body.text.format.strict && body.store === false)).toBe(true)
  await page.getByRole('button', { name: '使用此渠道' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await enter(page)
  await expect(page.getByRole('button', { name: '编辑消息', exact: true })).toHaveCount(1)
})

test('内容分区编辑校验完整协议，失败保留编辑内容并显示生成诊断', async ({ page }) => {
  await prepare(page)
  await enableChannel(page)
  await enter(page)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('请读书。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  await page.getByRole('button', { name: '生成详情', exact: true }).click()
  await expect(page.getByText('mock-request', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '编辑消息', exact: true }).last().click()
  const dialog = page.getByRole('dialog', { name: '编辑消息', exact: true })
  await dialog.getByRole('button', { name: '正文与对白 · 第 1 条', exact: true }).click()
  const input = dialog.getByRole('textbox', { name: '正文与对白 · 第 1 条 · 内容', exact: true })
  const tabs = (await dialog.getByRole('tablist').first().boundingBox())!
  expect((await input.boundingBox())!.y).toBeGreaterThanOrEqual(tabs.y + tabs.height)
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  )
  await input.fill('不够长')
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await expect(input).toHaveValue('不够长')
  const text = `修改后的书页。${narrativeFixture.blocks[0].text}`
  await input.fill(text)
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText(text, { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText(text, { exact: true })).toBeVisible()
  const saved = lastSavedMessage(await readOpfs(page))
  expect(saved?.reply?.kind).toBe('narrative')
  if (saved?.reply?.kind === 'narrative')
    expect(saved.reply.value.diary).toEqual(narrativeFixture.diary)
})

test('损坏存档在覆盖前被拒绝，原篇章仍可载入', async ({ page }) => {
  await prepare(page)
  await enter(page)
  await page.getByRole('button', { name: '存档管理' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出全部', exact: true }).click()
  const download = await downloadPromise
  const original = JSON.parse(await readFile((await download.path())!, 'utf8')) as SaveFile
  for (const damaged of [
    { ...original, messages: [{ ...original.messages[0], legacy: { body: '正文' } }] },
    { ...original, archives: [{ ...original.archives[0], lastUsage: { output: 1 } }] },
  ]) {
    await page.getByLabel('导入存档文件').setInputFiles({
      name: 'broken.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(damaged)),
    })
    await expect(page.getByText(/存档字段不完整或无效/).first()).toBeVisible()
    await expect(page.getByRole('dialog', { name: '导入并替换当前资料？' })).toHaveCount(0)
  }
  await page.getByRole('button', { name: '载入', exact: true }).click()
  await expect(page.getByText('第二篇章的开场。', { exact: true })).toBeVisible()
})

test('从指定消息分叉、单篇章导出和冲突存档合并都保留原记录', async ({ page }) => {
  await prepare(page)
  await enableChannel(page)
  await enter(page)
  for (const text of ['第一轮。', '第二轮。']) {
    await page.getByRole('textbox', { name: '聊天输入' }).fill(text)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
    await expect(page.getByText(text, { exact: true })).toBeVisible()
  }
  await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toHaveCount(2)
  await page.getByRole('button', { name: '从此分叉', exact: true }).nth(2).click()
  await expect(page).not.toHaveURL(/#\/chat\/archive-1$/)
  await expect(page.getByText('第一轮。', { exact: true })).toBeVisible()
  await expect(page.getByText('第二轮。', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '存档管理' }).click()
  await page.getByRole('textbox', { name: '搜索存档', exact: true }).fill('第二篇章')
  await expect(page.getByRole('button', { name: '导出 阅读篇章', exact: true })).toHaveCount(0)
  await page.getByRole('textbox', { name: '搜索存档', exact: true }).fill('')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 阅读篇章', exact: true }).click()
  const download = await downloadPromise
  const path = (await download.path())!
  const saved = JSON.parse(await readFile(path, 'utf8')) as SaveFile
  expect(saved.archives).toHaveLength(1)
  expect(saved.messages).toHaveLength(5)
  await page.getByRole('button', { name: '合并导入', exact: true }).click()
  await page.getByLabel('导入存档文件').setInputFiles(path)
  await page
    .getByRole('dialog', { name: '合并导入存档？', exact: true })
    .getByRole('button', { name: '确认', exact: true })
    .click()
  await expect(page.getByText('存档导入完成。渠道须重新测试。')).toBeVisible()
  await expect(page.getByText('第二轮。', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '存档管理' }).click()
  await expect(page.getByRole('button', { name: '导出 阅读篇章', exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: '导出 阅读篇章 · 分支', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: '导出 阅读篇章 · 导入', exact: true }),
  ).toBeVisible()
})

test('千条历史按需加载，导出保留全部消息', async ({ page }) => {
  await prepare(page, undefined, { historyTurns: 500, contextWindow: 1000000 })
  await enter(page)
  await expect(page.getByRole('button', { name: '编辑消息', exact: true })).toHaveCount(60)
  await page.getByRole('button', { name: /加载较早消息/ }).click()
  await expect(page.getByRole('button', { name: '编辑消息', exact: true })).toHaveCount(120)
  await page.getByRole('button', { name: '存档管理' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 阅读篇章', exact: true }).click()
  const download = await downloadPromise
  const data = JSON.parse(await readFile((await download.path())!, 'utf8')) as SaveFile
  expect(data.messages).toHaveLength(1001)
  expect(data.messages[0].id).toBe('opening')
})

test('两个窗口争用同一篇章时拒绝重复发送，停止后锁可立即重用', async ({ page, context }) => {
  await prepare(page)
  await enableChannel(page)
  await enter(page)
  await page.evaluate(() => {
    window.fetch = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            const partial = JSON.stringify({
              scene: { time: '2019年', location: '书房' },
              blocks: [{ kind: 'narration', text: '跨窗口生成中的正文', translation: '' }],
            }).slice(0, -1)
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ id: 'slow', created: 1, model: 'test-model', choices: [{ index: 0, delta: { content: partial }, finish_reason: null }] })}\n\n`,
              ),
            )
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
              once: true,
            })
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
  })
  await page.getByRole('textbox', { name: '聊天输入' }).fill('第一个窗口的请求')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('跨窗口生成中的正文', { exact: true })).toBeVisible()
  const second = await context.newPage()
  let secondRequests = 0
  await second.route(`${channelFixture.baseUrl}/chat/completions`, async (route) => {
    secondRequests++
    await route.fulfill({ contentType: 'text/event-stream', body: sse(narrativeFixture).join('') })
  })
  await second.goto(page.url())
  await expect(second.getByRole('button', { name: '重试回复', exact: true })).toHaveCount(0)
  await second.getByRole('textbox', { name: '聊天输入' }).fill('第二个窗口的请求')
  await second.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(second.getByText(/正在另一个窗口操作/).first()).toBeVisible()
  expect(secondRequests).toBe(0)
  await expect(second.getByRole('textbox', { name: '聊天输入' })).toHaveValue('第二个窗口的请求')
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  await second.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(second.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toBeVisible()
  await expect(second.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  expect(secondRequests).toBe(1)
  const saved = (await readOpfs(second))!.messages.filter(
    (message) => message.archiveId === 'archive-1',
  )
  expect(new Set(saved.map((message) => message.sequence)).size).toBe(saved.length)
  expect(saved.filter((message) => message.content === '第二个窗口的请求')).toHaveLength(1)
  await second.close()
})

test('导入持有全局锁时另一窗口不能排队发送到恢复后的同名篇章', async ({ page, context }) => {
  await prepare(page)
  await enableChannel(page)
  await enter(page)
  const second = await context.newPage()
  let secondRequests = 0
  await second.route(`${channelFixture.baseUrl}/chat/completions`, async (route) => {
    secondRequests++
    const body = route.request().postDataJSON() as Body
    const value =
      body.response_format.json_schema.name === 'ChannelCapability'
        ? { ready: true, echo: 'YanJu strict output' }
        : narrativeFixture
    await route.fulfill({
      contentType: body.stream ? 'text/event-stream' : 'application/json',
      body: body.stream ? sse(value).join('') : JSON.stringify(completion(value)),
    })
  })
  await second.goto(page.url())
  const input = second.getByRole('textbox', { name: '聊天输入' })
  await input.fill('导入期间旧窗口的发送')
  await page.getByRole('button', { name: '存档管理' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出全部', exact: true }).click()
  const backup = await downloadPromise
  await page.getByLabel('导入存档文件').setInputFiles((await backup.path())!)

  // Hold the lease store so the real import stays in progress until both tabs exercise its gate.
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('yanju-v2')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction('operations', 'readwrite')
    const store = transaction.objectStore('operations')
    let active = true
    const completed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onabort = () => {
        database.close()
        reject(transaction.error)
      }
    })
    const keepAlive = () => {
      const request = store.get('fixture-import-block')
      request.onsuccess = () => {
        if (active) keepAlive()
      }
    }
    keepAlive()
    ;(window as Window & { releaseImportFixture: () => Promise<void> }).releaseImportFixture =
      () => {
        active = false
        return completed
      }
  })
  const release = () =>
    page.evaluate(() =>
      (window as Window & { releaseImportFixture: () => Promise<void> }).releaseImportFixture(),
    )
  try {
    await page
      .getByRole('dialog', { name: '导入并替换当前资料？' })
      .getByRole('button', { name: '确认', exact: true })
      .click()
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await navigator.locks.query()).held?.some(
            (lock) => lock.name === 'yanju-import:yanju-v2' && lock.mode === 'exclusive',
          ),
        ),
      )
      .toBe(true)
    await second.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(second.getByText(/正在导入存档/).first()).toBeVisible()
    await expect(input).toHaveValue('导入期间旧窗口的发送')
    expect(secondRequests).toBe(0)
    await release()
    await expect(page.getByText('存档导入完成。渠道须重新测试。')).toBeVisible()
    await expect
      .poll(async () => (await readOpfs(page))?.messages.some((message) => message.role === 'user'))
      .toBe(false)
    await enableChannel(second)
    await second.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(second.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toBeVisible()
    await expect(second.getByRole('button', { name: '停止生成' })).toHaveCount(0)
    const saved = (await readOpfs(second))!.messages
    expect(saved.filter((message) => message.content === '导入期间旧窗口的发送')).toHaveLength(1)
  } finally {
    await release()
    await second.close()
  }
})

test('单条损坏的旧记录由局部恢复界面接住，编辑与导出仍可用', async ({ page }) => {
  await prepare(page)
  await enter(page)
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('yanju-v2')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('messages', 'readwrite')
      const store = transaction.objectStore('messages')
      const request = store.get('opening')
      request.onsuccess = () => store.put({ ...request.result, legacy: { body: '待修复正文' } })
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    database.close()
  })
  await page.reload()
  await expect(page.getByRole('button', { name: '导出当前资料', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '聊天输入' })).toBeVisible()
  await page.getByRole('button', { name: '编辑消息', exact: true }).click()
  await page.getByRole('textbox', { name: '消息内容', exact: true }).fill('已经修复的开场')
  await page.getByRole('button', { name: '保存修改', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '编辑消息', exact: true })).toHaveCount(0)
  await expect(page.getByText('已经修复的开场', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '导出当前资料', exact: true })).toHaveCount(0)
})
