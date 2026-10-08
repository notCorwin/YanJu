import { test, expect, type Page } from '@playwright/test'
import {
  channelFixture,
  capabilityFixture,
  completion,
  compressionFixture,
  forumFixture,
  narrativeFixture,
  sse,
} from '../fixtures'
import { defaults, type SaveFile } from '../../src/lib/types'
import { auxiliaryFixture } from '../auxiliary-fixtures'
import { taskDefinitions, type AuxiliaryKind, type TaskInput } from '../../src/lib/tasks'

async function readOpfs(page: Page): Promise<SaveFile | undefined> {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory()
      const directory = await root.getDirectoryHandle('yanju-v3')
      const handle = await directory.getFileHandle('save.json')
      return JSON.parse(await (await handle.getFile()).text())
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
  await expect(page.getByRole('button', { name: '载入', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '导出全部', exact: true })).toBeEnabled()
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
}

const isReply = (body: Body) =>
  ['NarrativeReply', 'ForumReply', 'ForumAppend'].includes(body.response_format.json_schema.name)

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
  await page.route(`${channelFixture.baseUrl}/chat/completions`, async (route) => {
    const body = route.request().postDataJSON() as Body
    requests.push(body)
    const fallback =
      body.response_format.json_schema.name === 'ChannelCapability'
        ? capabilityFixture
        : body.response_format.json_schema.name === 'ForumReply'
          ? forumFixture
          : body.response_format.json_schema.name === 'CompressionResult'
            ? compressionFixture
            : narrativeFixture
    const auxiliary = Object.entries(taskDefinitions).find(
      ([kind, definition]) =>
        definition.name === body.response_format.json_schema.name &&
        !['narrative', 'forum', 'compression', 'capability'].includes(kind),
    )
    const value = auxiliary
      ? auxiliaryFixture(
          auxiliary[0] as AuxiliaryKind,
          JSON.parse(body.messages[1].content) as TaskInput,
        )
      : fallback
    const response = respond?.(body) ?? { value }
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
  await page.evaluate(
    async ({ seed, channel, settings }) => {
      const modulePath = '/YanJu/src/lib/db.ts'
      const { importSave, db } = await import(modulePath)
      const archives = [
        {
          id: 'archive-1',
          name: '阅读篇章',
          createdAt: 1,
          updatedAt: 2,
          revision: 0,
          draft: '',
          userName: '测试读者',
        },
        {
          id: 'archive-2',
          name: '第二篇章',
          createdAt: 1,
          updatedAt: 1,
          revision: 0,
          draft: '',
          userName: '测试读者',
        },
      ]
      const messages = [
        {
          id: 'opening',
          archiveId: 'archive-1',
          role: 'assistant',
          kind: 'opening',
          status: 'complete',
          content: '午后的书房很安静，今天想读哪一本书？',
          sequence: 0,
          createdAt: 1,
        },
        ...Array.from({ length: (seed.historyTurns ?? 0) * 2 }, (_, i) => ({
          id: `history-${i}`,
          archiveId: 'archive-1',
          role: i % 2 ? 'assistant' : 'user',
          kind: i % 2 ? 'opening' : 'narrative',
          status: 'complete',
          content: `旧历史${i}：${'讨论阅读和明天的安排。'.repeat(seed.historyRepeats ?? 1)}`,
          sequence: i + 1,
          createdAt: i + 2,
        })),
        {
          id: 'opening-2',
          archiveId: 'archive-2',
          role: 'assistant',
          kind: 'opening',
          status: 'complete',
          content: '第二篇章的开场。',
          sequence: 0,
          createdAt: 1,
        },
      ]
      await importSave({
        version: 3,
        exportedAt: new Date().toISOString(),
        archives,
        messages,
        channels: [
          { ...channel, contextWindow: seed.contextWindow ?? 131072 },
          { ...channel, id: 'channel-2', name: '第二渠道', model: 'second-model' },
        ],
        masks: [
          {
            id: 'persona-1',
            name: '测试读者',
            gender: '其他',
            identity: '读者',
            prefer: '阅读',
            force: '不允许代替我说话。',
            createdAt: 1,
          },
        ],
        settings: {
          ...settings,
          activeArchiveId: 'archive-1',
          activeChannelId: 'channel-1',
          activePersonaId: 'persona-1',
        },
        storyStates: [],
        storyEvents: [],
        tasks: [],
        requests: [],
      })
      await db.persistence.flush()
    },
    { seed, channel: channelFixture, settings: defaults },
  )
  await page.reload()
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
  await expect(page.getByText(/50\s*条?\s*回答/)).toBeVisible()
  await expectArchiveAvailable(page)
  expect(lastSavedMessage(await readOpfs(page))?.reply).toEqual({
    kind: 'forum',
    value: {
      ...forumFixture,
      post: { ...forumFixture.post, author: '测试读者', content: '今天该读什么书？' },
    },
  })
  await page.getByRole('button', { name: /展开更多回答/ }).click()
  await expect(page.getByText('读者20', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '回复', exact: true }).first().click()
  await page.getByRole('textbox', { name: '内容', exact: true }).fill('谢谢推荐。')
  await page.getByRole('dialog').getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => requests.filter(isReply).length).toBe(3)
  await expectArchiveAvailable(page)
  expect(
    (await readOpfs(page))?.storyStates.find((state) => state.archiveId === 'archive-1')?.forums[0]
      .answers,
  ).toHaveLength(52)
  expect(
    requests.every(
      (r) => r.response_format.type === 'json_schema' && r.response_format.json_schema.strict,
    ),
  ).toBe(true)
  const history = requests.filter(isReply).at(-1)!.messages
  const context = JSON.parse(history[1].content) as TaskInput
  expect(context.text).toBe('谢谢推荐。')
  expect(JSON.stringify(context.context.forum)).toContain('answer-49')
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
    const before = requests.filter(isReply).at(-1)!
    expect(before.messages[1].role).toBe('system')
    expect(before.messages[1].content).toContain(JSON.stringify(compressionFixture))
    await expect(page.getByText(/^旧历史0：/)).toHaveCount(1)

    await page.reload()
    await page.getByRole('textbox', { name: '聊天输入' }).fill('明天继续阅读。')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toHaveCount(2)
    await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
    const after = requests.filter(isReply).at(-1)!
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
      return { value: capabilityFixture }
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
  expect(requests.filter(isReply)).toHaveLength(2)
  const corrected = requests.filter(isReply).at(-1)!
  expect(corrected.messages.at(-1)?.content).toContain('校验失败')

  await page.reload()
  await page.getByRole('textbox', { name: '聊天输入' }).fill('接着读。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toHaveCount(2)
  const next = requests.filter(isReply).at(-1)!
  expect(next.messages.slice(0, corrected.messages.length)).toEqual(corrected.messages)
  expect(next.response_format).toEqual(corrected.response_format)
})

test('渠道切换、存档链接、刷新和 v3 导入导出', async ({ page }) => {
  const requests = await prepare(page)
  await enableChannel(page)
  await enableChannel(page, '第二渠道')
  await enter(page)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('第二个模型。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect.poll(() => requests.filter(isReply).length).toBe(1)
  expect(requests.find(isReply)?.model).toBe('second-model')
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
  expect(requests.filter(isReply)).toHaveLength(0)
  await expect(input).toHaveValue('正在输入中文')
  await input.dispatchEvent('compositionend')
  await input.press('Shift+Enter')
  await expect(input).toHaveValue('正在输入中文\n')
  expect(requests.filter(isReply)).toHaveLength(0)
  await input.press('Enter')
  await expect.poll(() => requests.filter(isReply).length).toBe(1)
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
      return { value: capabilityFixture }
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
  expect(requests.filter(isReply)).toHaveLength(1)
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
      const request = indexedDB.deleteDatabase('yanju-v3')
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
  await page.getByRole('button', { name: '载入', exact: true }).click()
  await expect(page.getByText('第二篇章的开场。')).toBeVisible()
})

test('没有部分内容的模型错误结束后仍可管理和导出存档', async ({ page }) => {
  await prepare(page, (body) =>
    body.response_format.json_schema.name === 'ChannelCapability'
      ? { value: capabilityFixture }
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

async function narrativeAndStudio(page: Page) {
  const requests = await prepare(page)
  await enableChannel(page)
  await enter(page)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('一起阅读。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expectArchiveAvailable(page)
  await page.getByRole('button', { name: '剧情工作台', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '剧情工作台' })).toBeVisible()
  return requests
}
async function creationTask(page: Page, label: string, text: string) {
  const studio = page.getByRole('dialog', { name: '剧情工作台' })
  await studio.getByRole('tab', { name: '创作', exact: true }).click()
  await studio.getByRole('combobox', { name: '创作与管理能力' }).click()
  await page.getByRole('option', { name: label, exact: true }).click()
  await studio.getByRole('textbox', { name: '你的要求', exact: true }).fill(text)
  await studio.getByRole('button', { name: `生成${label}`, exact: true }).click()
  await expect(studio.getByRole('button', { name: '停止任务' })).toHaveCount(0)
  await expect(studio.getByRole('tab', { name: '任务', exact: true })).toHaveAttribute(
    'data-state',
    'active',
  )
  return studio
}

test('工作台档案、独立手机、日记日历、自然语言搜索和来源定位', async ({ page }) => {
  await narrativeAndStudio(page)
  const studio = page.getByRole('dialog', { name: '剧情工作台' })
  await expect(studio.getByText(/距求婚还有 60 天/)).toBeVisible()
  await studio.getByRole('combobox', { name: '档案分类' }).click()
  await page.getByRole('option', { name: '长期记忆', exact: true }).click()
  await expect(
    studio.getByText(narrativeFixture.effects.memories[0].content, { exact: true }),
  ).toBeVisible()
  await studio.getByRole('tab', { name: '交互', exact: true }).click()
  await studio.getByRole('textbox', { name: '手机消息' }).fill(' 原文\n明天见。 ')
  await studio.getByRole('button', { name: '发送手机消息' }).click()
  await expect(studio.getByText('明天的安排已经确认，我会准备好资料。')).toBeVisible()
  await expect
    .poll(
      async () =>
        (await readOpfs(page))?.storyStates.find((s) => s.archiveId === 'archive-1')?.phones[0]
          .messages.length,
    )
    .toBe(6)
  const phone = (await readOpfs(page))!.storyStates.find((s) => s.archiveId === 'archive-1')!
    .phones[0]
  expect(phone.messages.at(-2)?.text).toBe(' 原文\n明天见。 ')
  await studio.getByRole('combobox', { name: '独立交互' }).click()
  await page.getByRole('option', { name: '日记日历' }).click()
  await studio.getByLabel('剧情日期').fill('2019-06-01')
  await expect(studio.getByText('1 条记录', { exact: true })).toBeVisible()
  await studio.getByRole('tab', { name: '档案', exact: true }).click()
  await studio.getByRole('textbox', { name: '自然语言剧情搜索' }).fill('搜索宴雎的阅读事件')
  await studio.getByRole('button', { name: '搜索剧情' }).click()
  await expect(
    studio.getByText(narrativeFixture.effects.events[0].title, { exact: true }),
  ).toBeVisible()
  await studio.getByRole('button', { name: '查看来源' }).first().click()
  await expect(page).toHaveURL(/message=.*&block=b1/)
  await expect(page.getByRole('dialog', { name: '剧情工作台' })).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.id))
    .toContain('source-block-')
  await page.reload()
  await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toBeVisible()
})

test('人设草稿可编辑保存，续写分支选择后才推进', async ({ page }) => {
  const requests = await narrativeAndStudio(page)
  const studio = await creationTask(page, '人设草稿', '创建一位古籍修复者')
  await studio.getByRole('textbox', { name: '草稿姓名' }).fill('林霁')
  await studio.getByRole('button', { name: '保存人设草稿' }).click()
  await expect
    .poll(async () => (await readOpfs(page))?.masks.some((p) => p.name === '林霁'))
    .toBe(true)
  await creationTask(page, '续写分支', '提供三个后续行动')
  await expect(studio.getByRole('button', { name: '选择这个分支' })).toHaveCount(3)
  expect(
    requests.filter((r) => r.response_format.json_schema.name === 'NarrativeReply'),
  ).toHaveLength(1)
  await studio.getByRole('button', { name: '选择这个分支' }).first().click()
  await expect(page.getByRole('dialog', { name: '剧情工作台' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toHaveCount(2)
  await expectArchiveAvailable(page)
  expect(
    requests.filter((r) => r.response_format.json_schema.name === 'NarrativeReply'),
  ).toHaveLength(2)
  expect(requests.filter(isReply).at(-1)!.messages.at(-1)?.content).toContain(
    '我选择一起整理书页。',
  )
  await page.getByRole('button', { name: '剧情工作台', exact: true }).click()
  await creationTask(page, '篇章简介', '给篇章起名并整理简介')
  await studio.getByRole('button', { name: '保存篇章简介' }).click()
  await expect
    .poll(async () => (await readOpfs(page))?.archives.find((a) => a.id === 'archive-1')?.name)
    .toBe('书房里的午后')
})

test('论坛新帖50条、追加和局部改写失效重建均可在工作台完成', async ({ page }) => {
  await narrativeAndStudio(page)
  const studio = page.getByRole('dialog', { name: '剧情工作台' })
  await studio.getByRole('tab', { name: '交互', exact: true }).click()
  await studio.getByRole('combobox', { name: '独立交互' }).click()
  await page.getByRole('option', { name: '发布新帖', exact: true }).click()
  await studio.getByRole('textbox', { name: '新帖标题' }).fill('阅读推荐')
  await studio.getByRole('textbox', { name: '新帖内容' }).fill(' 标题：保留这行\n请推荐一本书。 ')
  await studio.getByRole('button', { name: '发布新帖', exact: true }).click()
  await expect(page.getByText(/50\s*条?\s*回答/)).toBeVisible()
  await expectArchiveAvailable(page)
  const post = (await readOpfs(page))!.storyStates.find((s) => s.archiveId === 'archive-1')!
    .forums[0]
  expect(post.post.title).toBe('阅读推荐')
  expect(post.post.content).toBe(' 标题：保留这行\n请推荐一本书。 ')
  await page.getByRole('button', { name: '回复', exact: true }).first().click()
  await page.getByRole('textbox', { name: '内容', exact: true }).fill('继续交流')
  await page.getByRole('dialog').getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByText(/52\s*条?\s*回答/)).toBeVisible()
  await page.getByRole('button', { name: '剧情工作台', exact: true }).click()
  await creationTask(page, '局部改写', '把午后改为傍晚，并修正相关状态')
  await studio.getByRole('button', { name: '应用改写' }).click()
  await expect
    .poll(
      async () =>
        (await readOpfs(page))?.storyStates.find((s) => s.archiveId === 'archive-1')?.forums.length,
    )
    .toBe(0)
  await studio.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByText('已失效 · 历史记录')).toHaveCount(3)
  await page.getByRole('button', { name: '剧情工作台', exact: true }).click()
  await creationTask(page, '一致性检查', '检查修改后的剧情')
  await expect(studio.getByText('确认午后时间与当前日期一致。')).toBeVisible()
})

test('资料 JSON 提取预览、媒体编辑导出、章节 Markdown 与自然语言操作', async ({ page }) => {
  await narrativeAndStudio(page)
  const studio = page.getByRole('dialog', { name: '剧情工作台' })
  await studio.getByRole('tab', { name: '资料', exact: true }).click()
  await studio.getByLabel('导入资料文件').setInputFiles({
    name: '人物.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ name: '陆明', identity: '图书管理员', prefer: '散文集' })),
  })
  await studio.getByRole('button', { name: '提取资料并预览' }).click()
  await expect(studio.getByText('未提供确切出生日期')).toBeVisible()
  expect(
    (await readOpfs(page))?.storyStates
      .find((s) => s.archiveId === 'archive-1')
      ?.entities.some((e) => e.name === '陆明'),
  ).toBe(false)
  await studio.getByRole('button', { name: '保存提取资料' }).click()
  await expect
    .poll(async () =>
      (await readOpfs(page))?.storyStates
        .find((s) => s.archiveId === 'archive-1')
        ?.entities.some((e) => e.name === '陆明'),
    )
    .toBe(true)
  await studio.getByRole('tab', { name: '媒体', exact: true }).click()
  await studio.getByRole('button', { name: '生成媒体描述与配乐建议' }).click()
  await expect(studio.getByRole('textbox', { name: '背景描述' })).toHaveValue(
    '午后书房，暖色窗光映在书页上。',
  )
  await studio.getByRole('textbox', { name: '背景描述' }).fill('书房背景，柔和的雨声与窗光。')
  await studio.getByRole('button', { name: '保存媒体描述' }).click()
  const jsonDownload = page.waitForEvent('download')
  await studio.getByRole('button', { name: '导出媒体描述 JSON' }).click()
  const json = await (await jsonDownload).createReadStream()
  const bytes = []
  for await (const chunk of json!) bytes.push(chunk)
  expect(JSON.parse(Buffer.concat(bytes).toString()).background).toBe(
    '书房背景，柔和的雨声与窗光。',
  )
  await studio.getByRole('textbox', { name: '背景描述' }).fill('')
  await expect(studio.getByRole('button', { name: '导出媒体描述 JSON' })).toBeDisabled()
  await studio.getByRole('textbox', { name: '背景描述' }).fill('书房背景，柔和的雨声与窗光。')
  await creationTask(page, '章节整理', '整理全部有效剧情')
  const mdDownload = page.waitForEvent('download')
  await studio.getByRole('button', { name: '导出整理后的剧情 Markdown' }).click()
  const markdown = await (await mdDownload).createReadStream()
  const mdBytes = []
  for await (const chunk of markdown!) mdBytes.push(chunk)
  expect(Buffer.concat(mdBytes).toString()).toContain('侬要看哪一本呀。')
  await studio.getByRole('button', { name: /请求记录（/ }).click()
  const requestDownload = page.waitForEvent('download')
  await studio.getByRole('button', { name: '导出请求记录 JSON' }).click()
  const requestStream = await (await requestDownload).createReadStream()
  const requestBytes = []
  for await (const chunk of requestStream!) requestBytes.push(chunk)
  const requests = JSON.parse(Buffer.concat(requestBytes).toString())
  expect(requests.map((r: { kind: string }) => r.kind)).toEqual(
    expect.arrayContaining(['capability', 'narrative', 'contentImport', 'media', 'chapters']),
  )
  expect(
    requests.every(
      (r: { request: { schema: { additionalProperties: boolean } } }) =>
        r.request.schema.additionalProperties === false,
    ),
  ).toBe(true)
  await creationTask(page, '自然语言操作', '切换到论坛模式')
  await studio.getByRole('button', { name: '执行操作' }).first().click()
  await expect(page.getByRole('combobox', { name: '聊天模式' })).toContainText('论坛')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
