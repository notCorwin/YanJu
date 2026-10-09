import { readFile } from 'node:fs/promises'
import { catalogFixture } from '../model-catalog-fixture'
import { expect, type Page } from '@playwright/test'
import { test, expandChannel, openAppAction, openChannels } from './fixtures'
import {
  channelFixture,
  capabilityFixture,
  completion,
  compressionFixture,
  forumFixture,
  narrativeFixture,
  sse,
  response,
  responseSse,
} from '../fixtures'
import type { SharePackage } from '../../src/lib/game-share'
import { defaults, type SaveFile } from '../../src/lib/types'
import { auxiliaryFixture } from '../auxiliary-fixtures'
import { taskDefinitions, type AuxiliaryKind, type TaskInput } from '../../src/lib/tasks'

async function readOpfs(page: Page): Promise<SaveFile | undefined> {
  return page.evaluate(async () => {
    const read = async () => {
      try {
        const root = await navigator.storage.getDirectory()
        const directory = await root.getDirectoryHandle('yanju-v4')
        const handle = await directory.getFileHandle('save.json')
        const raw = JSON.parse(await (await handle.getFile()).text())
        if (raw.format !== 'yanju-opfs-4') return raw
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
        const history = { ...raw.data.history }
        for (const ref of raw.historyFiles ?? [])
          history[ref.key].push(
            JSON.parse(await (await (await directory.getFileHandle(ref.file)).getFile()).text()),
          )
        return { ...raw.data, history, messages, settings: { ...raw.data.settings, bgImage } }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'NotFoundError') return undefined
        throw error
      }
    }
    return navigator.locks?.request ? navigator.locks.request('yanju-opfs:yanju-v4', read) : read()
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
  await openAppAction(page, '存档管理')
  await expect(page.getByRole('button', { name: '当前存档', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '载入', exact: true }).first()).toBeEnabled()
  await expect(page.getByRole('button', { name: '导出全部', exact: true })).toBeEnabled()
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
}

const requestName = (body: Body) =>
  body.response_format?.json_schema?.name ??
  Object.values(taskDefinitions).find((definition) =>
    body.messages[0]?.content.includes(definition.name),
  )?.name

const isReply = (body: Body) =>
  ['NarrativeReply', 'ForumReply', 'ForumAppend'].includes(requestName(body))

const businessRequests = (requests: Body[]) => requests.filter(isReply)

type Body = {
  model: string
  stream?: boolean
  response_format: { type: string; json_schema: { name: string; strict: boolean } }
  messages: { role: string; content: string }[]
}
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
  await page.route('https://models.dev/api.json', (route) =>
    route.fulfill({ json: catalogFixture(seed.contextWindow) }),
  )
  const requests: Body[] = []
  await page.route(`${channelFixture.baseUrl}/chat/completions`, async (route) => {
    const body = route.request().postDataJSON() as Body
    requests.push(body)
    const fallback =
      requestName(body) === 'ChannelCapability'
        ? capabilityFixture
        : requestName(body) === 'ForumReply'
          ? forumFixture
          : requestName(body) === 'CompressionResult'
            ? compressionFixture
            : narrativeFixture
    const auxiliary = Object.entries(taskDefinitions).find(
      ([kind, definition]) =>
        definition.name === requestName(body) &&
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
        'x-request-id': 'mock-request',
        'access-control-expose-headers': 'x-request-id',
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
  const channel = channelFixture
  const settings = defaults
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
  const data = {
    version: 4,
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
  }
  await openAppAction(page, '存档管理')
  await page.getByLabel('导入存档文件').setInputFiles({
    name: 'fixture-v4.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(data)),
  })
  await page
    .getByRole('dialog', { name: '导入并替换当前资料？', exact: true })
    .getByRole('button', { name: '确认', exact: true })
    .click()
  await expect(page.getByText('存档导入完成。渠道须重新测试。')).toBeVisible()
  await page.goto('./')
  await expect(page.getByRole('button', { name: '进入聊天' })).toBeVisible()
  return requests
}
async function enableChannel(
  page: Page,
  name = '测试渠道',
  options?: { mode?: 'auto' | 'responses' | 'chat-completions'; defaultTemperature?: boolean },
) {
  await openAppAction(page, '渠道管理')
  await expandChannel(page, name)
  if (options?.mode) {
    await page.getByRole('combobox', { name: 'API 端点' }).click()
    const label = {
      auto: '自动探测（Responses / Chat Completions）',
      responses: '/v1/responses',
      'chat-completions': '/v1/chat/completions',
    }[options.mode]
    await page.getByRole('option', { name: label, exact: true }).click()
  }
  if (options?.defaultTemperature) {
    await page.getByRole('combobox', { name: '温度设置' }).click()
    await page.getByRole('option', { name: '模型默认', exact: true }).click()
  }
  await page.locator('form').getByRole('button', { name: '测试渠道', exact: true }).click()
  await expect(page.getByText(/测试通过 ·/)).toBeVisible()
  await page.getByRole('button', { name: '使用此渠道' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
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
        'x-request-id': 'mock-request',
        'access-control-expose-headers': 'x-request-id',
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

test('手动和快速存档恢复草稿，分享导入创建独立篇章并保留自己的渠道', async ({ page }) => {
  await prepare(page)
  await enter(page)
  const input = page.getByRole('textbox', { name: '聊天输入' })
  const open = async () => {
    await openAppAction(page, '存档管理')
    await page.getByRole('button', { name: '存档与路线', exact: true }).click()
    return page.getByRole('dialog', { name: '存档与路线', exact: true })
  }
  const close = async () => {
    await page
      .getByRole('dialog', { name: '存档与路线', exact: true })
      .getByRole('button', { name: '关闭', exact: true })
      .click()
    await page
      .getByRole('dialog', { name: '存档', exact: true })
      .getByRole('button', { name: '关闭', exact: true })
      .click()
  }
  await input.fill('存档中的阅读进度')
  await expect
    .poll(async () => (await readOpfs(page))?.archives.find((a) => a.id === 'archive-1')?.draft)
    .toBe('存档中的阅读进度')
  let dialog = await open()
  await dialog.getByRole('textbox', { name: '存档位名称' }).fill('午后存档')
  await dialog.getByRole('button', { name: '保存到新存档位', exact: true }).click()
  await expect(dialog.getByText('午后存档', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '快速存档', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '快速读档', exact: true })).toBeEnabled()
  await close()
  await input.fill('之后的新草稿')
  dialog = await open()
  await dialog.getByRole('button', { name: '快速读档', exact: true }).click()
  await expect(page.getByText('快速存档已载入。', { exact: true })).toBeVisible()
  await close()
  await expect(input).toHaveValue('存档中的阅读进度')
  await page.reload()
  await expect(input).toHaveValue('存档中的阅读进度')
  dialog = await open()
  await dialog.getByRole('tab', { name: '分享', exact: true }).click()
  const downloaded = page.waitForEvent('download')
  await dialog.getByRole('button', { name: '导出分享文件' }).click()
  const path = (await (await downloaded).path())!
  const exported = JSON.parse(await readFile(path, 'utf8')) as SharePackage
  expect(exported.format).toBe('yanju-game')
  expect(exported.history.sessions).toHaveLength(1)
  expect(JSON.stringify(exported)).not.toContain('apiKey')
  expect(JSON.stringify(exported)).not.toContain('test-model')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByLabel('导入存档文件').setInputFiles(path)
  await expect(page).not.toHaveURL(/#\/chat\/archive-1$/)
  await expect(input).toHaveValue('存档中的阅读进度')
  await expect.poll(async () => (await readOpfs(page))?.archives.length).toBe(3)
  expect((await readOpfs(page))?.channels[0].apiKey).toBe(channelFixture.apiKey)
  dialog = await open()
  await dialog.getByRole('tab', { name: '存档位', exact: true }).click()
  const manual = dialog
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText('午后存档', { exact: true }) })
  await manual.getByRole('button', { name: '覆盖', exact: true }).click()
  await expect(page.getByText('存档位已覆盖。')).toBeVisible()
  await manual.getByRole('button', { name: '删除存档位', exact: true }).click()
  await expect(dialog.getByText('午后存档', { exact: true })).toHaveCount(0)
})

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
      await page.getByRole('button', { name: '更多聊天操作', exact: true }).click()
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
    if (requestName(body) === 'ChannelCapability') return { value: capabilityFixture }
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

test('渠道切换、存档链接、刷新和 v4 导入导出', async ({ page }) => {
  const requests = await prepare(page)
  await enableChannel(page)
  await enableChannel(page, '第二渠道')
  await enter(page)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('第二个模型。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect.poll(() => requests.filter(isReply).length).toBe(1)
  expect(requests.find(isReply)?.model).toBe('second-model')
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  await openAppAction(page, '存档管理')
  await page.getByRole('button', { name: '载入', exact: true }).click()
  await expect(page).toHaveURL(/#\/chat\/archive-2$/)
  await expect(page.getByText('第二篇章的开场。')).toBeVisible()
  await page.reload()
  await expect(page.getByText('第二篇章的开场。')).toBeVisible()
  await openAppAction(page, '存档管理')
  await page.getByRole('button', { name: '重命名 第二篇章' }).click()
  await page.getByRole('textbox', { name: '存档名称' }).fill('改名篇章')
  await page.getByRole('button', { name: '保存名称' }).click()
  await expect(
    page.getByRole('dialog', { name: '存档', exact: true }).getByText('改名篇章', { exact: true }),
  ).toBeVisible()
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
  await expect(page.getByRole('button', { name: '配置渠道', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled()
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
  expect(businessRequests(requests)).toHaveLength(0)
  if (await page.evaluate(() => matchMedia('(pointer: coarse)').matches)) {
    await input.press('Enter')
    await expect(input).toHaveValue('正在输入中文\n\n')
    expect(businessRequests(requests)).toHaveLength(0)
    await input.press('Control+Enter')
  } else await input.press('Enter')
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
    if (requestName(body) === 'ChannelCapability') return { value: capabilityFixture }
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

test('不支持 Structured Outputs 和 JSON mode 的渠道回退后仍可聊天', async ({ page }) => {
  const requests = await prepare(page, (body) =>
    body.response_format
      ? {
          status: 400,
          value: {
            error: { message: 'response_format unsupported', type: 'invalid_request_error' },
          },
        }
      : { value: requestName(body) === 'ChannelCapability' ? capabilityFixture : narrativeFixture },
  )
  await enableChannel(page)
  expect(requests).toHaveLength(6)
  expect(requests.map((body) => body.response_format?.type)).toEqual([
    'json_schema',
    'json_object',
    undefined,
    'json_schema',
    'json_object',
    undefined,
  ])
  await enter(page)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('回退模式继续剧情。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expectArchiveAvailable(page)
  expect(businessRequests(requests)).toHaveLength(1)
  expect(businessRequests(requests)[0].response_format).toBeUndefined()
  expect(businessRequests(requests)[0].messages[0].content).toContain('JSON Schema')
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
      const request = indexedDB.deleteDatabase('yanju-v4')
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('工作数据库仍有连接'))
    })
  })
  await recovered.goto('./#/chat/archive-1')
  await expect(recovered.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toBeVisible()
  await expect(recovered.getByRole('textbox', { name: '聊天输入' })).toHaveValue('未发送的草稿')
  await expect(recovered.getByRole('combobox', { name: '当前渠道' })).toContainText('测试渠道')
  const restoredAuthor = recovered
    .getByRole('article', { name: '你的消息' })
    .locator('[data-slot="message-header"]')
  await restoredAuthor.scrollIntoViewIfNeeded()
  await expect(restoredAuthor).toBeVisible()
  await expect(restoredAuthor).toContainText('测试读者')
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
  await openAppAction(page, '存档管理')
  await expect(page.getByText(/存档备份未完成：测试磁盘已满/)).toBeVisible()
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
  await expect(page.getByText(/全部更改已保存/)).toBeVisible()
  expect(lastSavedMessage(await readOpfs(page))?.reply?.value).toEqual(narrativeFixture)
  await page.getByRole('button', { name: '载入', exact: true }).click()
  await expect(page.getByText('第二篇章的开场。')).toBeVisible()
})

test('没有部分内容的模型错误结束后仍可管理和导出存档', async ({ page }) => {
  await prepare(page, (body) =>
    requestName(body) === 'ChannelCapability'
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

async function narrativeAndStudio(page: Page, seed: { contextWindow?: number } = {}) {
  const requests = await prepare(page, undefined, seed)
  await enableChannel(page)
  await enter(page)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('一起阅读。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expectArchiveAvailable(page)
  await page.getByRole('button', { name: '打开剧情工作台', exact: true }).click()
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
  await expect(page.getByRole('dialog', { name: '剧情工作台' })).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.id))
    .toContain('source-block-')
  await expect(page).not.toHaveURL(/[?&](message|block)=/)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('继续阅读。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toHaveCount(2)
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(page.getByRole('textbox', { name: '聊天输入' })).toBeFocused()
  await page.reload()
  await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toHaveCount(2)
})

test('续写发送被拒绝后可以重选，完整剧情提交前保持未应用', async ({ page }) => {
  await narrativeAndStudio(page)
  const studio = await creationTask(page, '续写分支', '提供三个行动')
  const saved = (await readOpfs(page))!
  const task = saved.tasks.find((t) => t.kind === 'continuation')!
  await studio.getByRole('button', { name: '关闭', exact: true }).click()
  await openChannels(page)
  await page.getByRole('button', { name: '删除渠道', exact: true }).click()
  await page
    .getByRole('dialog', { name: '删除渠道？', exact: true })
    .getByRole('button', { name: '确认', exact: true })
    .click()
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '打开剧情工作台', exact: true }).click()
  await studio.getByRole('button', { name: '选择这个分支' }).first().click()
  await expect(page.getByRole('dialog', { name: '剧情工作台' })).toHaveCount(0)
  await expect(page.getByText('请先配置渠道，并通过JSON 校验和浏览器连接测试。')).toBeVisible()
  expect((await readOpfs(page))!.tasks.find((t) => t.id === task.id)?.applied).not.toBe(true)
  await enableChannel(page, '第二渠道')
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`${channelFixture.baseUrl}/chat/completions`, async (route) => {
    const body = route.request().postDataJSON() as Body
    if (requestName(body) === 'NarrativeReply') await gate
    await route.fallback()
  })
  await page.getByRole('button', { name: '打开剧情工作台', exact: true }).click()
  await expect(studio.getByRole('button', { name: '选择这个分支' }).first()).toBeEnabled()
  await studio.getByRole('button', { name: '选择这个分支' }).first().click()
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible()
  expect(
    await page.evaluate(async (id) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('yanju-v4')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        return await new Promise<boolean | undefined>((resolve, reject) => {
          const request = database.transaction('tasks').objectStore('tasks').get(id)
          request.onsuccess = () => resolve(request.result?.applied)
          request.onerror = () => reject(request.error)
        })
      } finally {
        database.close()
      }
    }, task.id),
  ).not.toBe(true)
  release()
  await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toHaveCount(2)
  await expect
    .poll(async () => (await readOpfs(page))?.tasks.find((t) => t.id === task.id)?.applied)
    .toBe(true)
  await expectArchiveAvailable(page)
})

test('续写模型请求失败不标为已应用，重新生成分支后可推进', async ({ page }) => {
  await narrativeAndStudio(page, { contextWindow: 262144 })
  const studio = await creationTask(page, '续写分支', '提供三个行动')
  const task = (await readOpfs(page))!.tasks.find((t) => t.kind === 'continuation')!
  let fail = true
  await page.route(`${channelFixture.baseUrl}/chat/completions`, async (route) => {
    const body = route.request().postDataJSON() as Body
    if (requestName(body) === 'NarrativeReply' && fail) {
      fail = false
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '模拟分支生成失败' } }),
      })
    } else await route.fallback()
  })
  await studio.getByRole('button', { name: '选择这个分支' }).first().click()
  await expect(page.getByRole('dialog', { name: '剧情工作台' })).toHaveCount(0)
  await expect.poll(async () => lastSavedMessage(await readOpfs(page))?.status).toBe('failed')
  await expectArchiveAvailable(page)
  expect((await readOpfs(page))!.tasks.find((t) => t.id === task.id)?.applied).not.toBe(true)
  await page.getByRole('button', { name: '打开剧情工作台', exact: true }).click()
  await expect(studio.getByRole('button', { name: '选择这个分支' }).first()).toBeEnabled()
  await creationTask(page, '续写分支', '重试推进剧情')
  await studio.getByRole('button', { name: '选择这个分支' }).first().click()
  await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toHaveCount(2)
  await expect
    .poll(async () =>
      (await readOpfs(page))?.tasks.some((t) => t.kind === 'continuation' && t.applied),
    )
    .toBe(true)
  expect((await readOpfs(page))!.tasks.find((t) => t.id === task.id)?.applied).not.toBe(true)
})

test('关闭运行中的工作台后聊天仍锁定，手机提交完成后可继续聊天', async ({ page }) => {
  const requests = await narrativeAndStudio(page)
  const studio = page.getByRole('dialog', { name: '剧情工作台' })
  const revision = (await readOpfs(page))!.archives.find((a) => a.id === 'archive-1')!.revision
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(`${channelFixture.baseUrl}/chat/completions`, async (route) => {
    const body = route.request().postDataJSON() as Body
    if (requestName(body) === 'PhoneReply') await gate
    await route.fallback()
  })
  await studio.getByRole('tab', { name: '交互', exact: true }).click()
  await studio.getByRole('textbox', { name: '手机消息' }).fill('确认明天的安排')
  await studio.getByRole('button', { name: '发送手机消息' }).click()
  await expect(studio.getByRole('button', { name: '停止任务' })).toBeVisible()
  await studio.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('textbox', { name: '聊天输入' }).fill('等手机回复后继续阅读。')
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled()
  await expect(page.getByRole('combobox', { name: '聊天模式' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '清空当前聊天' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  await page.getByRole('textbox', { name: '聊天输入' }).press('Enter')
  expect((await readOpfs(page))!.archives.find((a) => a.id === 'archive-1')!.revision).toBe(
    revision,
  )
  release()
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled()
  await expect
    .poll(async () =>
      (await readOpfs(page))?.tasks.some((t) => t.kind === 'phoneReply' && t.applied),
    )
    .toBe(true)
  expect(
    requests.filter((r) => r.response_format.json_schema.name === 'NarrativeReply'),
  ).toHaveLength(1)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toHaveCount(2)
  await expectArchiveAvailable(page)
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
  await page.getByRole('button', { name: '打开剧情工作台', exact: true }).click()
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
  await expect(
    page.getByRole('region', { name: '聊天记录', exact: true }).getByText(/50\s*条?\s*回答/),
  ).toBeVisible()
  await expectArchiveAvailable(page)
  const post = (await readOpfs(page))!.storyStates.find((s) => s.archiveId === 'archive-1')!
    .forums[0]
  expect(post.answers).toHaveLength(50)
  expect(post.post.title).toBe('阅读推荐')
  expect(post.post.content).toBe(' 标题：保留这行\n请推荐一本书。 ')
  await page.getByRole('button', { name: '回复', exact: true }).first().click()
  await page.getByRole('textbox', { name: '内容', exact: true }).fill('继续交流')
  await page.getByRole('dialog').getByRole('button', { name: '发送', exact: true }).click()
  await expect(
    page.getByRole('region', { name: '聊天记录', exact: true }).getByText(/52\s*条?\s*回答/),
  ).toBeVisible()
  await page.getByRole('button', { name: '打开剧情工作台', exact: true }).click()
  await creationTask(page, '局部改写', '把午后改为傍晚，并修正相关状态')
  await studio.getByRole('button', { name: '应用改写' }).click()
  await expect
    .poll(
      async () =>
        (await readOpfs(page))?.storyStates.find((s) => s.archiveId === 'archive-1')?.forums.length,
    )
    .toBe(0)
  await studio.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByText('已失效 · 历史记录')).toHaveCount(0)
  await page.getByRole('button', { name: '打开剧情工作台', exact: true }).click()
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

test('自动优先 Responses，叙事、论坛、摘要续聊及 v4 存档往返', async ({ page }) => {
  const { requests, chatRequests } = await prepareResponses(page)
  await enableChannel(page, '测试渠道', { mode: 'auto', defaultTemperature: true })
  expect(requests).toHaveLength(2)
  expect(chatRequests).toHaveLength(2)
  await enter(page)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('一起读书吧。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: /DIARY \/ COUNTDOWN/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  await page.getByRole('button', { name: '更多聊天操作', exact: true }).click()
  await page.getByRole('button', { name: '压缩上下文', exact: true }).click()
  await expect(page.getByText('上下文压缩完成，原文保留。')).toBeVisible()
  expect(requests.filter((r) => r.text.format.name === 'CompressionResult')).toHaveLength(1)
  await page.getByRole('combobox', { name: '聊天模式' }).click()
  await page.getByRole('option', { name: '论坛', exact: true }).click()
  await page.getByRole('textbox', { name: '聊天输入' }).fill('今天该读什么书？')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText(/50\s*条?\s*回答/)).toBeVisible()
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText(/50\s*条?\s*回答/)).toBeVisible()
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
  await openChannels(page)
  await expect(page.getByText(/当前协议：Responses/)).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'API 端点' })).toContainText('自动探测')
  await expect(page.getByRole('combobox', { name: '温度设置' })).toContainText('模型默认')
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await openAppAction(page, '存档管理')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出全部' }).click()
  const path = await (await downloadPromise).path()
  const exported = JSON.parse(await readFile(path!, 'utf8'))
  expect(exported.version).toBe(4)
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
  await openChannels(page)
  await expect(page.getByRole('button', { name: '使用此渠道' })).toBeDisabled()
  await expect(page.getByRole('combobox', { name: 'API 端点' })).toContainText('自动探测')
  await expect(page.getByRole('combobox', { name: '温度设置' })).toContainText('模型默认')
})

test('手动协议、取消重测保留结果，配置修改使缓存失效', async ({ page }) => {
  const { requests, chatRequests } = await prepareResponses(page)
  await enableChannel(page, '测试渠道', { mode: 'responses' })
  expect(requests).toHaveLength(2)
  expect(chatRequests).toHaveLength(0)
  await openChannels(page)
  let pending = false
  let release = () => {}
  await page.route(`${channelFixture.baseUrl}/responses`, async (route) => {
    pending = true
    await new Promise<void>((resolve) => {
      release = resolve
    })
    await route.fulfill({ json: response(capabilityFixture) }).catch(() => {})
  })
  await page.locator('form').getByRole('button', { name: '测试渠道', exact: true }).click()
  await expect.poll(() => pending).toBe(true)
  await expect(page.getByRole('status').filter({ hasText: /正在测试 Responses/ })).toBeVisible()
  await page.getByRole('button', { name: '取消测试', exact: true }).click()
  await expect(page.getByText('渠道测试已取消，原测试结果已保留。')).toBeVisible()
  release()
  await expect(page.getByRole('button', { name: '使用此渠道' })).toBeEnabled()
  await expect(page.getByText(/当前协议：Responses/)).toBeVisible()
  await page.getByRole('combobox', { name: 'API 端点' }).click()
  await page.getByRole('option', { name: '/v1/chat/completions', exact: true }).click()
  await expect(page.getByRole('button', { name: '使用此渠道' })).toBeDisabled()
  await expect(page.getByText(/当前协议：Responses/)).toHaveCount(0)
  await page.locator('form').getByRole('button', { name: '测试渠道', exact: true }).click()
  await expect(page.getByText(/当前协议：Chat Completions/)).toBeVisible()
  await page.getByRole('button', { name: '使用此渠道' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await enter(page)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('切换协议后继续。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect.poll(() => businessRequests(chatRequests).length).toBe(1)
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  await page.reload()
  await openChannels(page)
  await expect(page.getByText(/当前协议：Chat Completions/)).toBeVisible()
  await page.getByRole('combobox', { name: '模型', exact: true }).click()
  await page.getByRole('option', { name: 'new-model · new-model', exact: true }).click()
  await expect(page.getByRole('button', { name: '使用此渠道' })).toBeDisabled()
})

for (const action of ['修改', '删除']) {
  test(`测试全部期间其他标签页${action}渠道，不覆盖配置或复活记录`, async ({ page, context }) => {
    await prepare(page)
    await enableChannel(page)
    const other = await context.newPage()
    await other.goto('./')
    await openChannels(other)
    await expandChannel(other, '测试渠道')
    await openChannels(page)
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
      await other.getByRole('combobox', { name: '模型', exact: true }).click()
      await other
        .getByRole('option', {
          name: 'new-model-from-other-tab · new-model-from-other-tab',
          exact: true,
        })
        .click()
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
          .getByRole('heading')
          .getByRole('button', { name: '测试渠道', exact: true }),
      ).toHaveCount(0)
    }
    release()
    await expect(
      page.getByText('渠道测试已结束；1 个渠道配置已变更或删除，旧测试结果未保存。请重新测试。'),
    ).toBeVisible()
    await other.reload()
    await openChannels(other)
    if (action === '修改') {
      await expandChannel(other, '测试渠道')
      await expect(other.getByRole('combobox', { name: '模型', exact: true })).toContainText(
        'new-model-from-other-tab',
      )
      await expect(other.getByRole('button', { name: '使用此渠道', exact: true })).toBeDisabled()
    } else {
      await expect(
        other
          .getByRole('navigation', { name: '渠道列表' })
          .getByRole('heading')
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
      page
        .getByText(terminal === 'incomplete' ? /回复达到模型自身容量/ : /未返回完整终止事件/)
        .first(),
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
  await openChannels(page)
  await page.getByRole('button', { name: '完整协议测试', exact: true }).click()
  await expect(page.getByText(/测试通过 · 完整协议/)).toBeVisible()
  expect(requests.map((body) => requestName(body))).toEqual([
    'ChannelCapability',
    'ChannelCapability',
    'NarrativeReply',
    'ForumReply',
    'CompressionResult',
  ])
  expect(requests.filter((body) => body.stream)).toHaveLength(3)
  await page.getByRole('button', { name: '使用此渠道' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await enter(page)
  await expect(page.getByRole('button', { name: '编辑消息', exact: true })).toHaveCount(1)
})

test('自动选定 Responses 后完整协议测试仍覆盖叙事论坛摘要并保留诊断', async ({ page }) => {
  const { requests, chatRequests } = await prepareResponses(page)
  await openChannels(page)
  await page.getByRole('combobox', { name: 'API 端点' }).click()
  await page
    .getByRole('option', { name: '自动探测（Responses / Chat Completions）', exact: true })
    .click()
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
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
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
  await dialog.getByRole('tab', { name: '正文', exact: true }).click()
  const input = dialog.getByRole('textbox', { name: '内容', exact: true }).first()
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
  await openAppAction(page, '存档管理')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出全部', exact: true }).click()
  const download = await downloadPromise
  const original = JSON.parse(await readFile((await download.path())!, 'utf8')) as SaveFile
  for (const damaged of [
    { ...original, messages: [{ ...original.messages[0], diagnostics: { elapsedMs: 1 } }] },
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

test('从指定消息分叉、切换原路线和完整篇章分享保留全部未来', async ({ page }) => {
  await prepare(page)
  await enableChannel(page)
  await enter(page)
  for (const text of ['第一轮。', '第二轮。']) {
    await page.getByRole('textbox', { name: '聊天输入' }).fill(text)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
    await expect(page.getByText(text, { exact: true })).toBeVisible()
  }
  await page.getByRole('button', { name: '从此分叉', exact: true }).nth(2).click()
  await expect(page).toHaveURL(/#\/chat\/archive-1$/)
  await expect(page.getByText('第一轮。', { exact: true })).toBeVisible()
  await expect(page.getByText('第二轮。', { exact: true })).toHaveCount(0)
  await openAppAction(page, '存档管理')
  await page.getByRole('button', { name: '存档与路线', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '存档与路线', exact: true })
  await dialog.getByRole('tab', { name: '路线', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '载入路线' })).toHaveCount(2)
  await dialog.getByRole('button', { name: '载入路线' }).first().click()
  await expect(page.getByText('路线最新进度已载入。')).toBeVisible()
  await dialog.getByRole('tab', { name: '分享', exact: true }).click()
  await dialog.getByRole('combobox', { name: '分享范围' }).click()
  await page.getByRole('option', { name: '整个篇章、全部路线与存档位' }).click()
  const downloaded = page.waitForEvent('download')
  await dialog.getByRole('button', { name: '导出分享文件' }).click()
  const path = (await (await downloaded).path())!
  const saved = JSON.parse(await readFile(path, 'utf8')) as SharePackage
  expect(saved.history.branches).toHaveLength(2)
  expect(
    saved.history.messageVersions
      .map((v) => v.value.id)
      .filter((id, i, ids) => ids.indexOf(id) === i),
  ).toHaveLength(5)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByLabel('导入存档文件').setInputFiles(path)
  await expect(page).not.toHaveURL(/#\/chat\/archive-1$/)
  await expect(page.getByText('第二轮。', { exact: true })).toBeVisible()
  await openAppAction(page, '存档管理')
  await page.getByRole('button', { name: '存档与路线', exact: true }).click()
  await dialog.getByRole('tab', { name: '路线', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '载入路线' })).toHaveCount(2)
})

test('千条历史按需加载，导出保留全部消息', async ({ page }) => {
  await prepare(page, undefined, { historyTurns: 500, contextWindow: 1000000 })
  await enter(page)
  await expect(page.getByRole('button', { name: '编辑消息', exact: true })).toHaveCount(60)
  await page.getByRole('button', { name: /加载较早消息/ }).click()
  await expect(page.getByRole('button', { name: '编辑消息', exact: true })).toHaveCount(120)
  await openAppAction(page, '存档管理')
  await page.getByRole('button', { name: '存档与路线', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '存档与路线', exact: true })
  await dialog.getByRole('tab', { name: '分享', exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await dialog.getByRole('button', { name: '导出分享文件' }).click()
  const download = await downloadPromise
  const data = JSON.parse(await readFile((await download.path())!, 'utf8')) as SharePackage
  const node = data.history.nodes.find((n) => n.id === data.history.sessions[0].nodeId)!
  expect(node.messageIds).toHaveLength(1001)
  expect(data.history.messageVersions.find((v) => v.id === node.messageIds[0])!.value.id).toBe(
    'opening',
  )
})

test('生成中快速读档取消请求，刷新和路线切换仍可恢复中断内容', async ({ page }) => {
  await prepare(page)
  await enableChannel(page)
  await enter(page)
  await openAppAction(page, '存档管理')
  await page.getByRole('button', { name: '存档与路线', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '存档与路线', exact: true })
  await dialog.getByRole('button', { name: '快速存档', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '快速读档', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page
    .getByRole('dialog', { name: '存档', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  await page.evaluate(() => {
    window.fetch = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            const partial = JSON.stringify({
              scene: { time: '2019年', location: '书房' },
              blocks: [{ kind: 'narration', text: '读档前生成的部分内容', translation: '' }],
            }).slice(0, -1)
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ id: 'slow', created: 1, model: 'test-model', choices: [{ index: 0, delta: { content: partial }, finish_reason: null }] })}\n\n`,
              ),
            )
            init?.signal?.addEventListener(
              'abort',
              () => controller.error(new DOMException('已取消', 'AbortError')),
              { once: true },
            )
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
  })
  await page.getByRole('textbox', { name: '聊天输入' }).fill('生成中的问题')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('读档前生成的部分内容', { exact: true })).toBeVisible()
  await openAppAction(page, '存档管理')
  await page.getByRole('button', { name: '存档与路线', exact: true }).click()
  await dialog.getByRole('button', { name: '快速读档', exact: true }).click()
  await expect(page.getByText('快速存档已载入。', { exact: true })).toBeVisible()
  await dialog.getByRole('tab', { name: '路线', exact: true }).click()
  await dialog.getByRole('button', { name: '载入路线', exact: true }).click()
  await expect(page.getByText('路线最新进度已载入。', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page
    .getByRole('dialog', { name: '存档', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  await expect(page.getByText('读档前生成的部分内容', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText('读档前生成的部分内容', { exact: true })).toBeVisible()
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
  await expect(second.getByText('跨窗口生成中的正文', { exact: true })).toBeVisible()
  await expect(second.getByText('生成中', { exact: true })).toBeVisible()
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
    const value = requestName(body) === 'ChannelCapability' ? capabilityFixture : narrativeFixture
    await route.fulfill({
      contentType: body.stream ? 'text/event-stream' : 'application/json',
      body: body.stream ? sse(value).join('') : JSON.stringify(completion(value)),
    })
  })
  await second.goto(page.url())
  const input = second.getByRole('textbox', { name: '聊天输入' })
  await input.fill('导入期间旧窗口的发送')
  await openAppAction(page, '存档管理')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出全部', exact: true }).click()
  const backup = await downloadPromise
  await page.getByLabel('导入存档文件').setInputFiles((await backup.path())!)

  // Hold the lease store so the real import stays in progress until both tabs exercise its gate.
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('yanju-v4')
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
            (lock) => lock.name === 'yanju-import:yanju-v4' && lock.mode === 'exclusive',
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

test('单条损坏的 v4 记录由局部恢复界面接住，编辑与导出仍可用', async ({ page }) => {
  await prepare(page)
  await enter(page)
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('yanju-v4')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('messages', 'readwrite')
      const store = transaction.objectStore('messages')
      const request = store.get('opening')
      request.onsuccess = () => store.put({ ...request.result, content: { broken: true } })
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

test('模型目录等待中停止生成，目录稍后返回也不会发送渠道请求', async ({ page }) => {
  const requests = await prepare(page)
  await enableChannel(page)
  await enter(page)
  await page.reload()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let catalogStarted = false
  await page.route('https://models.dev/api.json', async (route) => {
    catalogStarted = true
    await held
    await route.fulfill({ json: catalogFixture() })
  })
  await page.getByRole('textbox', { name: '聊天输入' }).fill('等目录加载时停止。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect.poll(() => catalogStarted).toBe(true)
  await page.getByRole('button', { name: '停止生成' }).click()
  await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)
  expect(businessRequests(requests)).toHaveLength(0)
  const catalogResponse = page.waitForResponse('https://models.dev/api.json')
  release()
  await catalogResponse
  await expectArchiveAvailable(page)
  expect(businessRequests(requests)).toHaveLength(0)
})

test('刷新模型目录改变 API 后立即撤销已测试渠道的可用状态', async ({ page }) => {
  await prepare(page)
  await enableChannel(page)
  await openChannels(page)
  await expect(page.getByText(/测试通过 ·/)).toBeVisible()
  const catalog = catalogFixture()
  catalog.mock.api = 'https://new-catalog.example/v2'
  await page.route('https://models.dev/api.json', (route) => route.fulfill({ json: catalog }))
  await page.getByRole('button', { name: '刷新模型目录', exact: true }).click()
  await expect(page.getByText(/测试通过 ·/)).toHaveCount(0)
  await expect(page.getByText('模型目录或渠道配置已变更，请重新测试渠道。')).toBeVisible()
  await expect(page.getByRole('button', { name: '使用此渠道', exact: true })).toBeDisabled()
  await expect(
    page
      .getByRole('navigation', { name: '渠道列表' })
      .getByRole('heading')
      .locator('.lucide-check'),
  ).toHaveCount(0)
})
