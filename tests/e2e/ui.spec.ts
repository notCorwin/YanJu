import { expect, type Page } from '@playwright/test'
import { test, ensureComposer, expandChannel, openAppAction, openChannels } from './fixtures'
import {
  channelFixture,
  capabilityFixture,
  completion,
  forumFixture,
  narrativeFixture,
  response,
  responseSse,
  sse,
} from '../fixtures'
import { defaults, type SaveFile } from '../../src/lib/types'

async function mockUI(page: Page) {
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort())
  await page.route('https://mock.example/v1/**', async (route) => {
    const body = route.request().postDataJSON()
    const responses = route.request().url().endsWith('/responses')
    const name = responses ? body.text.format.name : body.response_format.json_schema.name
    const value =
      name === 'ChannelCapability'
        ? capabilityFixture
        : name === 'ForumReply'
          ? forumFixture
          : narrativeFixture
    await route.fulfill({
      headers: {
        'access-control-allow-origin': '*',
        'content-type': body.stream ? 'text/event-stream' : 'application/json',
      },
      body: body.stream
        ? (responses ? responseSse(value) : sse(value)).join('')
        : JSON.stringify(responses ? response(value) : completion(value)),
    })
  })
}

async function prepareUI(page: Page, archiveCount = 2) {
  await mockUI(page)
  await page.goto('./')
  await expect(page.getByRole('button', { name: '进入聊天' })).toBeVisible()
  const data: SaveFile = {
    version: 4,
    exportedAt: new Date().toISOString(),
    archives: Array.from({ length: archiveCount }, (_, index) => ({
      id: `archive-${index + 1}`,
      name: index ? `阅读计划 ${index + 1}` : '午后的书房',
      createdAt: 1,
      updatedAt: archiveCount - index,
      revision: 0,
      draft: '',
      userName: '林知遥',
    })),
    messages: Array.from({ length: archiveCount }, (_, index) => ({
      id: `opening-${index}`,
      archiveId: `archive-${index + 1}`,
      role: 'assistant',
      kind: 'opening',
      status: 'complete',
      content: `篇章 ${index + 1}：午后的书房很安静。`,
      sequence: 0,
      createdAt: 1,
    })),
    channels: [{ ...channelFixture, name: '阅读渠道' }],
    masks: [
      {
        id: 'persona-1',
        name: '林知遥',
        gender: '其他',
        identity: '读者',
        prefer: '阅读',
        force: '不允许代替我说话。',
        createdAt: 1,
      },
    ],
    settings: {
      ...defaults,
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
    name: 'ui-fixture-v4.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(data)),
  })
  await page
    .getByRole('dialog', { name: '导入并替换当前资料？', exact: true })
    .getByRole('button', { name: '确认', exact: true })
    .click()
  await expect(page.getByText('存档导入完成。渠道须重新测试。', { exact: true })).toBeVisible()
  await page.goto('./')
  await expect(page.getByRole('button', { name: '进入聊天', exact: true })).toBeVisible()
}

async function connectUI(page: Page) {
  await openChannels(page)
  await page.locator('form').getByRole('button', { name: '测试渠道', exact: true }).click()
  await expect(page.getByText(/测试通过 ·/)).toBeVisible()
  await page.getByRole('button', { name: '使用此渠道', exact: true }).click()
  await page.getByRole('button', { name: '关闭提示', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '渠道管理', exact: true })).toBeVisible()
  await page
    .getByRole('dialog', { name: '渠道管理', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

async function enterUI(page: Page) {
  await page.getByRole('button', { name: '进入聊天', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '聊天输入' })).toBeVisible()
}

test('字段验证、未保存修改和关闭后的键盘焦点', async ({ page }) => {
  await prepareUI(page)
  const opener = page.getByRole('button', { name: '渠道管理', exact: true })
  await opener.click()
  await expandChannel(page)
  const key = page.getByRole('textbox', { name: 'API Key', exact: true })
  await key.fill('')
  await page.getByRole('button', { name: '保存渠道', exact: true }).click()
  await expect(key).toHaveAttribute('aria-invalid', 'true')
  await expect(key).toBeFocused()
  await expect(page.getByText('请输入渠道提供的 API Key。', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Base URL', exact: true })).toHaveCount(0)
  await expect(page.getByText('输出上限（tokens）', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  await expect(key).toHaveValue('')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await confirmation.getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener).toBeFocused()
  await connectUI(page)
  await enterUI(page)
  await expect(page.getByRole('combobox', { name: '当前渠道', exact: true })).toContainText(
    '阅读渠道',
  )
})

test('指令可点击并保存草稿，音乐状态在面板重开后保持一致', async ({ page }) => {
  await prepareUI(page)
  await enterUI(page)
  let holdMedia = true
  let releaseMedia: () => void = () => {}
  const mediaGate = new Promise<void>((resolve) => {
    releaseMedia = resolve
  })
  await page.route('https://cdn.jsdelivr.net/**/*.mp3', async (route) => {
    if (holdMedia) await mediaGate
    await route.abort('failed').catch(() => {})
  })
  const opener = page.getByRole('button', { name: '世界、指令与音乐', exact: true })
  await opener.click()
  await page.getByRole('tab', { name: '指令', exact: true }).click()
  const command = page.getByRole('button', { name: '填入聊天', exact: true }).first()
  await command.scrollIntoViewIfNeeded()
  await expect(command).toBeInViewport()
  const panel = await page.getByRole('tabpanel').boundingBox()
  const tabs = await page.getByRole('tablist').boundingBox()
  expect(panel!.y).toBeGreaterThanOrEqual(tabs!.y + tabs!.height - 1)
  await command.click()
  const input = page.getByRole('textbox', { name: '聊天输入', exact: true })
  await expect(input).toBeFocused()
  const inserted = await input.inputValue()
  expect(inserted.length).toBeGreaterThan(10)
  await page.reload()
  await expect(input).toHaveValue(inserted)
  await opener.click()
  await page.getByRole('tab', { name: '音乐', exact: true }).click()
  const volume = page.getByRole('slider', { name: '音量', exact: true })
  await volume.fill('0.3')
  await expect(page.getByRole('slider', { name: '播放进度', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '播放音乐', exact: true }).click()
  try {
    await expect(page.getByRole('button', { name: '取消加载音乐', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '取消加载音乐', exact: true }).click()
    await expect(page.getByRole('button', { name: '播放音乐', exact: true })).toBeVisible()
    expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(
      true,
    )
  } finally {
    holdMedia = false
    releaseMedia()
  }
  await page.getByRole('button', { name: '下一曲', exact: true }).click()
  await expect(page.locator('audio')).toHaveAttribute(
    'src',
    'https://cdn.jsdelivr.net/gh/hmt20061008-oss/music@main/true.mp3',
  )
  await expect(page.getByText('暂时无法播放', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '重试播放', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener).toBeFocused()
  await opener.click()
  await expect(page.getByRole('tab', { name: '音乐', exact: true })).toHaveAttribute(
    'data-state',
    'active',
  )
  await expect(volume).toHaveValue('0.3')
  expect(
    await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.volume),
  ).toBeCloseTo(0.3)
})

test('结构化回复按分区编辑、取消和刷新后仍然可读', async ({ page }, testInfo) => {
  await prepareUI(page)
  await connectUI(page)
  await enterUI(page)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('一起读书吧。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('SCENE / 场景', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
  await page.getByText('SCENE / 场景', { exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('narrative.png'), fullPage: true })
  const editorOpener = page.getByRole('button', { name: '编辑消息', exact: true }).last()
  await editorOpener.click()
  await page.getByRole('tab', { name: '场景', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '地点', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '地点', exact: true }).fill('')
  await page.getByRole('button', { name: '保存修改', exact: true }).click()
  await expect(page.getByText('场景 → 地点 不能为空', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '地点', exact: true }).fill('窗边的旧书房')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page
    .getByRole('dialog', { name: '放弃未保存的修改？', exact: true })
    .getByRole('button', { name: '取消', exact: true })
    .click()
  await expect(page.getByRole('textbox', { name: '地点', exact: true })).toHaveValue('窗边的旧书房')
  await page.getByRole('tab', { name: '手机', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '备忘录 1', exact: true })).toBeVisible()
  const newMemo = narrativeFixture.phone.memos.length + 1
  await page.getByRole('button', { name: '添加备忘录', exact: true }).click()
  const memo = page.getByRole('textbox', { name: `备忘录 ${newMemo}`, exact: true })
  await memo.fill('明天把书还给图书馆。')
  await expect(memo).toHaveValue('明天把书还给图书馆。')
  await page.getByRole('button', { name: `删除备忘录 ${newMemo}`, exact: true }).click()
  await expect(memo).toHaveCount(0)
  await page.getByRole('button', { name: '保存修改', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(editorOpener).toBeFocused()
  await page.reload()
  await expect(page.getByText('窗边的旧书房', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /DEVICE \/ INTERFACE/ }).click()
  await expect(page.getByRole('heading', { name: '备忘录', exact: true })).toBeInViewport()
})

test('流式回复完成后保留已展开的回答', async ({ page }) => {
  await prepareUI(page)
  await connectUI(page)
  await enterUI(page)
  await page.evaluate((frames) => {
    const original = window.fetch.bind(window)
    window.fetch = async (url, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      if (!body?.stream) return original(url, init)
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const frame of frames.slice(0, -1)) controller.enqueue(encoder.encode(frame))
            Object.assign(window, {
              finishForumStream: () => {
                controller.enqueue(encoder.encode(frames.at(-1)!))
                controller.close()
              },
            })
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('Cancelled', 'AbortError')),
            )
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
  }, sse(forumFixture))
  await page.getByRole('combobox', { name: '聊天模式', exact: true }).click()
  await page.getByRole('option', { name: '论坛', exact: true }).click()
  await page
    .getByRole('textbox', { name: '聊天输入', exact: true })
    .fill('阅读习惯有哪些值得讨论的地方？')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
  const more = page.getByRole('button', { name: /展开更多回答/ })
  await more.click()
  await expect(more).toBeFocused()
  await expect(page.getByRole('button', { name: '回复', exact: true })).toHaveCount(20)
  const reply = page.getByRole('article', { name: '宴雎的回复', exact: true }).last()
  // Finishing the stream must update the existing message, including its animation.
  const animation = await reply.evaluate((element) => element.getAnimations()[0]?.startTime)
  expect(animation).toBeDefined()
  await page.evaluate(() =>
    (window as unknown as { finishForumStream: () => void }).finishForumStream(),
  )
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '回复', exact: true })).toHaveCount(20)
  await expect(more).toContainText('还有 30 条')
  await expect(more).toBeFocused()
  expect(await reply.evaluate((element) => element.getAnimations()[0]?.startTime)).toBe(animation)
  const reading = page.getByRole('region', { name: '聊天记录', exact: true })
  await expect(page.getByRole('button', { name: '从此分叉', exact: true }).last()).toBeEnabled()
  await reading.dispatchEvent('wheel', { deltaY: -10000 })
  await reading.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll'))
  })
  await page.getByRole('button', { name: '更多聊天操作', exact: true }).click()
  const latest = page.getByRole('button', { name: '回到最新消息', exact: true })
  await expect(latest).toBeVisible()
  await latest.click()
  await expect(page.getByRole('button', { name: /展开更多回答/ })).toBeInViewport()
})

test('论坛的错误提示和未发送内容可以返回继续编辑', async ({ page }) => {
  await prepareUI(page)
  await connectUI(page)
  await enterUI(page)
  await page.getByRole('combobox', { name: '聊天模式', exact: true }).click()
  await page.getByRole('option', { name: '论坛', exact: true }).click()
  await page.getByRole('textbox', { name: '聊天输入' }).fill('讨论读书习惯。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: '发布帖子', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '发布帖子', exact: true }).click()
  await page
    .getByRole('dialog', { name: '发布帖子', exact: true })
    .getByRole('button', { name: '发送', exact: true })
    .click()
  await expect(page.getByRole('textbox', { name: '帖子标题', exact: true })).toBeFocused()
  await expect(page.getByText('请输入帖子标题。', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '帖子标题', exact: true }).fill('怎样记住书里的细节')
  await page
    .getByRole('textbox', { name: '内容', exact: true })
    .fill('我想保留这段尚未发送的想法。')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '放弃未发送的内容？', exact: true })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '内容', exact: true })).toHaveValue(
    '我想保留这段尚未发送的想法。',
  )
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await confirmation.getByRole('button', { name: '放弃内容', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('多篇章搜索、创建命名和无效链接的恢复路径', async ({ page }) => {
  await prepareUI(page, 14)
  await openAppAction(page, '存档管理')
  const search = page.getByRole('searchbox', { name: '搜索存档', exact: true })
  await search.fill('阅读计划 14')
  await expect(page.getByText('找到 1 个篇章', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '载入', exact: true }).click()
  await expect(page).toHaveURL(/#\/chat\/archive-14$/)
  await expect(page.getByText('篇章 14：午后的书房很安静。', { exact: true })).toBeVisible()
  await openAppAction(page, '存档管理')
  await page.getByRole('button', { name: '新建', exact: true }).click()
  const name = page.getByRole('textbox', { name: '存档名称', exact: true })
  await name.fill('')
  await page.getByRole('button', { name: '创建并进入聊天', exact: true }).click()
  await expect(name).toBeFocused()
  await expect(page.getByText('请输入存档名称。', { exact: true })).toBeVisible()
  await name.fill('周末的阅读计划')
  await name.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page).toHaveTitle('周末的阅读计划 · 宴雎')
  await page.evaluate(() => {
    window.location.hash = '/chat/%E0%A4%A'
  })
  await expect(page.getByText('这个篇章尚未在此浏览器保存', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '打开存档列表', exact: true }).click()
  await search.fill('找不到的名字')
  await expect(page.getByText('没有找到匹配的篇章', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '查看全部存档', exact: true }).click()
  await expect(page.getByText('共 15 个篇章', { exact: true })).toBeVisible()
  await expect(page.getByText('周末的阅读计划', { exact: true })).toBeVisible()
})

test('最窄屏幕、大字号、长名称和长草稿仍保留可用的阅读空间', async ({ page }) => {
  await prepareUI(page)
  await connectUI(page)
  await enterUI(page)
  await openAppAction(page, '人设管理')
  await page
    .getByRole('textbox', { name: '姓名', exact: true })
    .fill('一个喜欢在书房读书的人'.repeat(8))
  await page.getByRole('button', { name: '使用此人设', exact: true }).click()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await openAppAction(page, '外观设置')
  const font = page.getByRole('spinbutton', { name: '聊天字号 · 像素', exact: true })
  await font.fill('')
  await font.press('2')
  await expect(font).toHaveValue('2')
  await font.press('4')
  await expect(font).toHaveValue('24')
  await page.getByRole('spinbutton', { name: '界面字号 · 像素', exact: true }).fill('18')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.setViewportSize({ width: 320, height: 568 })
  await ensureComposer(page)
  const input = page.getByRole('textbox', { name: '聊天输入', exact: true })
  const longDraft = '阅读以后想记下的想法。'.repeat(250)
  await input.fill(longDraft)
  const measurements = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: document
      .querySelector('[data-slot="message-scroller-viewport"]')!
      .getBoundingClientRect().height,
    input: document.querySelector('textarea')!.getBoundingClientRect().height,
  }))
  expect(measurements.width).toBe(320)
  expect(measurements.viewport).toBeGreaterThanOrEqual(180)
  expect(measurements.input).toBeLessThanOrEqual(284)
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeInViewport()
  await page.reload()
  await ensureComposer(page)
  await expect(input).toHaveValue(longDraft)
  await page
    .getByRole('dialog', { name: '撰写消息', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  await page.getByRole('button', { name: '应用菜单', exact: true }).click()
  await expect(page.getByRole('button', { name: '人设管理', exact: true })).toBeInViewport()
  await page.setViewportSize({ width: 667, height: 375 })
  await openAppAction(page, '人设管理')
  await expect(page.getByRole('button', { name: '保存人设', exact: true })).toBeInViewport()
  await expect(page.getByRole('textbox', { name: '姓名', exact: true })).toBeInViewport()
})

test('首次进入按渠道测试、保存人设的顺序打开当前篇章', async ({ page }) => {
  await mockUI(page)
  await page.goto('./')
  await page.getByRole('button', { name: '进入聊天', exact: true }).click()
  await expect(page).toHaveURL(/#\/setup\/channels$/)
  const next = page.getByRole('button', { name: '继续设置人设', exact: true })
  await expect(next).toBeDisabled()
  await page.getByRole('button', { name: '新建渠道', exact: true }).click()
  await expandChannel(page, '新渠道')
  await page.getByRole('combobox', { name: 'Provider', exact: true }).click()
  await page.getByRole('option', { name: '测试 Provider', exact: true }).click()
  await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('test-key')
  await page.getByRole('button', { name: '保存渠道', exact: true }).click()
  await expect(next).toBeDisabled()
  await page.locator('form').getByRole('button', { name: '测试渠道', exact: true }).click()
  await expect(page.getByText(/测试通过 ·/)).toBeVisible()
  await expect(next).toBeDisabled()
  await page.getByRole('button', { name: '使用此渠道', exact: true }).click()
  await expect(next).toBeEnabled()
  await next.click()
  await expect(page).toHaveURL(/#\/setup\/persona$/)
  const name = page.getByRole('textbox', { name: '姓名', exact: true })
  await name.fill('')
  await page.getByRole('button', { name: '使用此人设', exact: true }).click()
  await expect(name).toBeFocused()
  await expect(page.getByText('请输入人设姓名。', { exact: true })).toBeVisible()
  await name.fill('林知遥')
  await page.getByRole('button', { name: '使用此人设', exact: true }).click()
  await expect(page.getByText('当前人设已更新。', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '进入聊天', exact: true }).click()
  await expect(page).toHaveURL(/#\/chat\/[^?]+$/)
  await expect(page.getByRole('textbox', { name: '聊天输入', exact: true })).toBeVisible()
  await openAppAction(page, '返回首页')
  await page.getByRole('button', { name: '进入聊天', exact: true }).click()
  await expect(page).toHaveURL(/#\/chat\/[^?]+$/)
})

test('引导中的浏览器返回和页面退出都保护未保存修改', async ({ page }) => {
  await prepareUI(page)
  await page.goto('./#/setup/channels')
  await expandChannel(page)
  const key = page.getByRole('textbox', { name: 'API Key', exact: true })
  await key.fill('尚未保存的 Key')
  await page.goBack()
  const confirmation = page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true })
  await expect(confirmation).toBeVisible()
  await expect(page).toHaveURL(/#\/setup\/channels$/)
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  await expect(key).toHaveValue('尚未保存的 Key')
  await openAppAction(page, '返回首页')
  await confirmation.getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Abyss & Desire', exact: true })).toBeVisible()
  await page.goto('./#/setup/persona')
  const name = page.getByRole('textbox', { name: '姓名', exact: true })
  await name.fill('还没有保存的姓名')
  await page.getByRole('button', { name: '进入聊天', exact: true }).click()
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  await expect(name).toHaveValue('还没有保存的姓名')
  await openAppAction(page, '返回首页')
  await confirmation.getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Abyss & Desire', exact: true })).toBeVisible()
  await page.goto('./#/setup/persona')
  await expect(name).toHaveValue('林知遥')
})

test('封面入口即时可用，减少动态效果后仍保留外观设置与离线阅读', async ({ page }, testInfo) => {
  await prepareUI(page)
  await page.reload()
  await expect(page.getByRole('button', { name: '进入聊天', exact: true })).toBeEnabled()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const cover = page.getByRole('heading', { name: 'Abyss & Desire', exact: true })
  await expect(cover).toBeVisible()
  expect(
    await cover.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element.parentElement!).animationDuration),
    ),
  ).toBeLessThan(0.001)
  await page.screenshot({ path: testInfo.outputPath('cover.png'), fullPage: true })
  const viewport = page.viewportSize()!
  await page.setViewportSize({ width: 320, height: 568 })
  const main = page.getByRole('main')
  const width = await main.evaluate((element) => ({
    content: element.scrollWidth,
    available: element.clientWidth,
  }))
  expect(width.content).toBe(width.available)
  const titleBounds = (await cover.boundingBox())!
  const playerBounds = (await page
    .getByRole('button', { name: '展开世界与音乐', exact: true })
    .boundingBox())!
  expect(titleBounds.y).toBeGreaterThanOrEqual(playerBounds.y + playerBounds.height)
  await page.getByRole('button', { name: '进入聊天', exact: true }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', { name: '进入聊天', exact: true })).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('cover-narrow.png'), fullPage: true })
  await page.setViewportSize(viewport)
  await openAppAction(page, '外观设置')
  await page.getByRole('combobox', { name: '字体', exact: true }).click()
  await page.getByRole('option', { name: '系统字体', exact: true }).click()
  await page.getByRole('spinbutton', { name: '聊天字号 · 像素', exact: true }).fill('20')
  await page.getByLabel('背景图片', { exact: true }).setInputFiles({
    name: 'background.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  })
  await expect(page.getByRole('button', { name: '移除背景', exact: true })).toBeEnabled()
  await page.getByRole('slider', { name: /背景透明度/ }).fill('35')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await enterUI(page)
  await expect(page.getByText('篇章 1：午后的书房很安静。', { exact: true })).toBeVisible()
  await page.reload()
  const typography = await page
    .getByRole('article', { name: '宴雎的回复', exact: true })
    .evaluate((element) => ({
      font: getComputedStyle(element.querySelector('[data-slot="bubble-content"]')!).fontFamily,
      size: getComputedStyle(element.querySelector('[data-slot="bubble-content"]')!).fontSize,
    }))
  expect(typography.font).toContain('system-ui')
  expect(typography.size).toBe('20px')
  const background = await page.evaluate(() => ({
    image: getComputedStyle(document.documentElement).getPropertyValue('--background-image'),
    opacity: getComputedStyle(document.documentElement).getPropertyValue('--background-opacity'),
  }))
  expect(background.image).toContain('blob:')
  expect(Number(background.opacity)).toBe(0.35)
  await page.screenshot({ path: testInfo.outputPath('chat.png'), fullPage: true })
})

test('唱片跟随真实播放状态，收起浮窗和切换页面后继续播放', async ({ page }, testInfo) => {
  const samples = 8000 * 60
  const audio = Buffer.alloc(44 + samples * 2)
  audio.write('RIFF', 0)
  audio.writeUInt32LE(audio.length - 8, 4)
  audio.write('WAVEfmt ', 8)
  audio.writeUInt32LE(16, 16)
  audio.writeUInt16LE(1, 20)
  audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(8000, 24)
  audio.writeUInt32LE(16000, 28)
  audio.writeUInt16LE(2, 32)
  audio.writeUInt16LE(16, 34)
  audio.write('data', 36)
  audio.writeUInt32LE(samples * 2, 40)
  await page.route('https://cdn.jsdelivr.net/**/*.mp3', (route) =>
    route.fulfill({ contentType: 'audio/wav', body: audio }),
  )
  await prepareUI(page)
  const opener = page.getByRole('button', { name: '展开世界与音乐', exact: true })
  await opener.click()
  const setting = page.getByRole('button', { name: '背景 · SETTING', exact: true })
  const places = page.getByRole('button', { name: '地点 · 主要场景', exact: true })
  await setting.click()
  await places.click()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await opener.click()
  await expect(setting).toHaveAttribute('aria-expanded', 'false')
  await expect(places).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('tab', { name: '音乐', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '世界与音乐', exact: true })
  await expect
    .poll(async () => {
      const bounds = (await panel.boundingBox())!
      return page.viewportSize()!.width - bounds.x - bounds.width
    })
    .toBeCloseTo(16, 0)
  const bounds = (await panel.boundingBox())!
  expect(bounds.y).toBeGreaterThanOrEqual(16)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height - 16)
  const record = page.locator('[data-record]')
  await expect(record).toHaveAttribute('data-playing', 'false')
  await page.getByRole('slider', { name: '音量', exact: true }).fill('0.3')
  await page.getByRole('button', { name: '切换到单曲循环', exact: true }).click()
  await page.getByRole('button', { name: '播放音乐', exact: true }).click()
  await expect(page.getByRole('button', { name: '暂停音乐', exact: true })).toBeVisible()
  await expect(record).toHaveAttribute('data-playing', 'true')
  expect(
    await record
      .locator('.animate-record')
      .first()
      .evaluate((element) => getComputedStyle(element).animationPlayState),
  ).toBe('running')
  await page.screenshot({ path: testInfo.outputPath('music.png'), fullPage: true })
  const elapsed = await page
    .locator('audio')
    .evaluate((element: HTMLAudioElement) => element.currentTime)
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(opener).toBeFocused()
  await expect(record).toHaveCount(0)
  await enterUI(page)
  await expect(page.getByRole('button', { name: '展开世界与音乐', exact: true })).toHaveCount(0)
  await expect
    .poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeGreaterThan(elapsed)
  expect(await page.locator('audio').evaluate((element: HTMLAudioElement) => element.paused)).toBe(
    false,
  )
  await page.getByRole('button', { name: '世界、指令与音乐', exact: true }).click()
  await expect(page.getByRole('tab', { name: '音乐', exact: true })).toHaveAttribute(
    'data-state',
    'active',
  )
  await expect(page.getByRole('slider', { name: '音量', exact: true })).toHaveValue('0.3')
  await expect(page.getByRole('button', { name: '切换到列表循环', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '暂停音乐', exact: true }).click()
  await expect(record).toHaveAttribute('data-playing', 'false')
  expect(
    await record
      .locator('.animate-record')
      .first()
      .evaluate((element) => getComputedStyle(element).animationPlayState),
  ).toBe('paused')
})

test('网络字体尚未响应时，应用也能显示并进入聊天', async ({ page }) => {
  await prepareUI(page)
  let releaseFonts: () => void = () => {}
  const fontGate = new Promise<void>((resolve) => {
    releaseFonts = resolve
  })
  let requested = false
  await page.route('https://fonts.googleapis.com/**', async (route) => {
    requested = true
    await fontGate
    await route.fulfill({ contentType: 'text/css', body: '/* remote fonts are unavailable */' })
  })
  try {
    await page.reload({ waitUntil: 'commit' })
    await expect.poll(() => requested).toBe(true)
    await expect(page.getByRole('button', { name: '进入聊天', exact: true })).toBeVisible({
      timeout: 3000,
    })
    await enterUI(page)
    await expect(page.getByText('篇章 1：午后的书房很安静。', { exact: true })).toBeVisible()
  } finally {
    releaseFonts()
  }
})

test('渠道默认折叠、独立展开，自定义名称保存后在模型切换与重开中保留', async ({ page }) => {
  await prepareUI(page)
  await openAppAction(page, '渠道管理')
  const list = page.getByRole('navigation', { name: '渠道列表', exact: true })
  const first = list.getByRole('button', { name: '阅读渠道', exact: true })
  await expect(first).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('textbox', { name: '渠道名称', exact: true })).toHaveCount(0)
  await expandChannel(page, '阅读渠道')
  const firstPanel = list.locator('[data-slot="accordion-item"]').first()
  const name = firstPanel.getByRole('textbox', { name: '渠道名称', exact: true })
  await name.fill('长篇创作 · 私人渠道')
  await firstPanel.getByRole('button', { name: '保存渠道', exact: true }).click()
  const renamed = list.getByRole('button', { name: '长篇创作 · 私人渠道', exact: true })
  await expect(renamed).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('button', { name: '新建渠道', exact: true }).click()
  const second = list.getByRole('button', { name: '新渠道', exact: true })
  await expect(second).toHaveAttribute('aria-expanded', 'false')
  await second.click()
  await expect(renamed).toHaveAttribute('aria-expanded', 'true')
  await expect(second).toHaveAttribute('aria-expanded', 'true')
  await second.click()
  await expect(renamed).toHaveAttribute('aria-expanded', 'true')
  await expect(second).toHaveAttribute('aria-expanded', 'false')
  await name.fill('未保存的渠道名')
  await renamed.click()
  const confirmation = page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  await expect(name).toHaveValue('未保存的渠道名')
  await renamed.click()
  await confirmation.getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(renamed).toHaveAttribute('aria-expanded', 'false')
  await expandChannel(page, '长篇创作 · 私人渠道')
  await expect(name).toHaveValue('长篇创作 · 私人渠道')
  await firstPanel.getByRole('combobox', { name: '模型', exact: true }).click()
  await page.getByRole('option', { name: 'new-model · new-model', exact: true }).click()
  await expect(name).toHaveValue('长篇创作 · 私人渠道')
  await firstPanel.getByRole('button', { name: '保存渠道', exact: true }).click()
  await page
    .getByRole('dialog', { name: '渠道管理', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  await openAppAction(page, '渠道管理')
  await expect(renamed).toHaveAttribute('aria-expanded', 'false')
  await page.reload()
  await openAppAction(page, '渠道管理')
  await expandChannel(page, '长篇创作 · 私人渠道')
  await expect(name).toHaveValue('长篇创作 · 私人渠道')
})

test('桌面、移动端、窄屏与横屏的四个入口保持同一行，阅读区至少占屏幕 85%', async ({
  page,
}, testInfo) => {
  await prepareUI(page)
  await connectUI(page)
  await enterUI(page)
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport)
    const controls = [
      page.getByRole('combobox', { name: '当前渠道', exact: true }),
      page.getByRole('button', { name: '打开剧情工作台', exact: true }),
      page.getByRole('button', { name: '世界、指令与音乐', exact: true }),
      page.getByRole('button', { name: '清空当前聊天', exact: true }),
    ]
    const bounds = []
    for (const control of controls) {
      await expect(control).toBeInViewport()
      bounds.push((await control.boundingBox())!)
    }
    expect(
      Math.max(...bounds.map((box) => box.y)) - Math.min(...bounds.map((box) => box.y)),
    ).toBeLessThanOrEqual(1)
    expect(bounds.every((box) => box.height >= 44)).toBe(true)
    const reading = page.getByRole('region', { name: '聊天记录', exact: true })
    await expect
      .poll(async () => (await reading.boundingBox())!.height)
      .toBeGreaterThanOrEqual(viewport.height * 0.85 - 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width)
    await expect(page.getByRole('button', { name: '展开世界与音乐', exact: true })).toHaveCount(0)
    if (viewport.height > 640) {
      await page
        .getByRole('textbox', { name: '聊天输入', exact: true })
        .fill('很长的阅读草稿。'.repeat(200))
      await page.getByRole('button', { name: '应用菜单', exact: true }).focus()
      await expect
        .poll(async () => (await reading.boundingBox())!.height)
        .toBeGreaterThanOrEqual(viewport.height * 0.85 - 1)
    } else {
      await ensureComposer(page)
      await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeInViewport()
      await page
        .getByRole('dialog', { name: '撰写消息', exact: true })
        .getByRole('button', { name: '关闭', exact: true })
        .click()
    }
    await page.screenshot({
      path: testInfo.outputPath(`chat-${viewport.width}x${viewport.height}.png`),
    })
  }
})

test('每条消息可以单独删除，取消、删除和刷新均保留其他聊天原文', async ({ page }) => {
  await prepareUI(page)
  await connectUI(page)
  await enterUI(page)
  await page.getByRole('textbox', { name: '聊天输入', exact: true }).fill('这条回应稍后删除。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
  await expect(page.getByRole('article')).toHaveCount(3)
  const records = () =>
    page.getByRole('article').evaluateAll((elements) =>
      elements.map((element) => ({
        id: element.id,
        content: element.querySelector('[data-slot="bubble-content"]')?.textContent,
      })),
    )
  const original = await records()
  const user = page.getByRole('article', { name: '你的消息', exact: true })
  await user.getByRole('button', { name: '删除消息', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '删除这条消息？', exact: true })
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  await expect(confirmation).toHaveCount(0)
  await expect.poll(records).toEqual(original)
  await user.getByRole('button', { name: '删除消息', exact: true }).click()
  await confirmation.getByRole('button', { name: '删除消息', exact: true }).click()
  await expect(user).toHaveCount(0)
  await expect(confirmation).toHaveCount(0)
  await expect.poll(records).toEqual(original.filter((record) => record.id !== original[1].id))
  await page.reload()
  await expect(page.getByRole('article')).toHaveCount(2)
  await expect(confirmation).toHaveCount(0)
  await expect.poll(records).toEqual(original.filter((record) => record.id !== original[1].id))
  await page
    .getByRole('article')
    .first()
    .getByRole('button', { name: '删除消息', exact: true })
    .click()
  await confirmation.getByRole('button', { name: '删除消息', exact: true }).click()
  await expect(page.getByRole('article')).toHaveCount(1)
  expect(await records()).toEqual([original[2]])
})

test('移动端键盘压缩视口时保留输入焦点与草稿，收起输入后恢复阅读空间', async ({ page }) => {
  await prepareUI(page)
  await connectUI(page)
  await enterUI(page)
  await page.setViewportSize({ width: 390, height: 844 })
  const input = page.getByRole('textbox', { name: '聊天输入', exact: true })
  await input.fill('输入中的草稿')
  await expect(input).toBeFocused()
  await page.setViewportSize({ width: 390, height: 390 })
  await expect(input).toBeVisible()
  await expect(input).toBeFocused()
  await input.press('End')
  await page.keyboard.insertText('。')
  await expect(input).toHaveValue('输入中的草稿。')
  await page.getByRole('button', { name: '应用菜单', exact: true }).focus()
  await expect(page.getByRole('button', { name: '撰写消息', exact: true })).toBeVisible()
  const reading = page.getByRole('region', { name: '聊天记录', exact: true })
  await expect
    .poll(async () => (await reading.boundingBox())!.height)
    .toBeGreaterThanOrEqual(390 * 0.85 - 1)
  await ensureComposer(page)
  await expect(input).toHaveValue('输入中的草稿。')
  await page
    .getByRole('dialog', { name: '撰写消息', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click()
  await expect(page.getByRole('button', { name: '撰写消息', exact: true })).toBeFocused()
})
