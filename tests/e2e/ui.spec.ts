import { expect, type Page } from '@playwright/test'
import { test } from './fixtures'
import {
  capabilityFixture,
  completion,
  forumFixture,
  narrativeFixture,
  response,
  responseSse,
  sse,
} from '../fixtures'

async function prepareUI(page: Page, archiveCount = 2) {
  await page.addInitScript((count) => {
    if (localStorage.getItem('ui-seeded')) return
    localStorage.setItem('ui-seeded', 'true')
    localStorage.setItem(
      'yanju_archives',
      JSON.stringify(
        Array.from({ length: count }, (_, index) => ({
          id: `archive-${index + 1}`,
          name: index ? `阅读计划 ${index + 1}` : '午后的书房',
          createdAt: 1,
          updatedAt: count - index,
          messages: [
            {
              id: `opening-${index}`,
              role: 'assistant',
              content: `篇章 ${index + 1}：午后的书房很安静。`,
              timestamp: 1,
            },
          ],
        })),
      ),
    )
    localStorage.setItem(
      'yanju_masks',
      JSON.stringify([
        {
          id: 'persona-1',
          name: '林知遥',
          gender: '其他',
          identity: '读者',
          prefer: '阅读',
          force: '不允许代替我说话。',
          createdAt: 1,
        },
      ]),
    )
    localStorage.setItem(
      'yanju_channels',
      JSON.stringify([
        {
          id: 'channel-1',
          name: '阅读渠道',
          baseUrl: 'https://mock.example/v1',
          apiKey: 'test-key-not-real',
          model: 'test-model',
          apiMode: 'chat-completions',
          temperature: 0.9,
          maxTokens: 4096,
          contextWindow: 131072,
          createdAt: 1,
        },
      ]),
    )
    localStorage.setItem('yanju_archive_cur', JSON.stringify('archive-1'))
    localStorage.setItem('yanju_channel_cur', JSON.stringify('channel-1'))
    localStorage.setItem('yanju_mask_cur', JSON.stringify('persona-1'))
  }, archiveCount)
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
  await page.goto('./')
  await expect(page.getByRole('button', { name: '进入聊天' })).toBeVisible()
}

async function connectUI(page: Page) {
  await page.getByRole('button', { name: '渠道管理', exact: true }).click()
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
  const name = page.getByRole('textbox', { name: '渠道名称', exact: true })
  await name.fill('')
  await page.getByRole('textbox', { name: 'Base URL', exact: true }).fill('file:///tmp/mock')
  await page.getByRole('button', { name: '保存渠道', exact: true }).click()
  await expect(name).toHaveAttribute('aria-invalid', 'true')
  await expect(name).toBeFocused()
  await expect(page.getByText('请输入渠道名称。', { exact: true })).toBeVisible()
  await expect(page.getByText(/请输入完整的 HTTP/)).toBeVisible()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  await expect(name).toHaveValue('')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await confirmation.getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(opener).toBeFocused()
  await connectUI(page)
  await enterUI(page)
  await expect(page.getByRole('combobox', { name: '当前渠道', exact: true })).toHaveText('阅读渠道')
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

test('结构化回复按分区编辑、取消和刷新后仍然可读', async ({ page }) => {
  await prepareUI(page)
  await connectUI(page)
  await enterUI(page)
  await page.getByRole('textbox', { name: '聊天输入' }).fill('一起读书吧。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('SCENE / 场景', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
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
  await page.evaluate(() =>
    (window as unknown as { finishForumStream: () => void }).finishForumStream(),
  )
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '回复', exact: true })).toHaveCount(20)
  await expect(more).toContainText('还有 30 条')
  await expect(more).toBeFocused()
  const reading = page.getByRole('region', { name: '聊天记录', exact: true })
  await expect(page.getByRole('button', { name: '从此分叉', exact: true }).last()).toBeEnabled()
  await reading.dispatchEvent('wheel', { deltaY: -10000 })
  await reading.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll'))
  })
  const latest = page.getByRole('button', { name: '回到最新消息', exact: true })
  await expect(latest).toBeVisible()
  const readingBounds = (await reading.boundingBox())!
  const latestBounds = (await latest.boundingBox())!
  expect(latestBounds.y).toBeGreaterThanOrEqual(readingBounds.y + readingBounds.height)
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
  await page.getByRole('button', { name: '存档管理', exact: true }).click()
  const search = page.getByRole('searchbox', { name: '搜索存档', exact: true })
  await search.fill('阅读计划 14')
  await expect(page.getByText('找到 1 个篇章', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '载入', exact: true }).click()
  await expect(page).toHaveURL(/#\/chat\/archive-14$/)
  await expect(page.getByText('篇章 14：午后的书房很安静。', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '存档管理', exact: true }).click()
  await page.getByRole('button', { name: '新建', exact: true }).click()
  const name = page.getByRole('textbox', { name: '存档名称', exact: true })
  await name.fill('')
  await page.getByRole('button', { name: '创建并进入聊天', exact: true }).click()
  await expect(name).toBeFocused()
  await expect(page.getByText('请输入存档名称。', { exact: true })).toBeVisible()
  await name.fill('周末的阅读计划')
  await name.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('header p')).toHaveText('周末的阅读计划')
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
  await page.getByRole('button', { name: '人设管理', exact: true }).click()
  await page
    .getByRole('textbox', { name: '姓名', exact: true })
    .fill('一个喜欢在书房读书的人'.repeat(8))
  await page.getByRole('button', { name: '使用此人设', exact: true }).click()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '外观设置', exact: true }).click()
  const font = page.getByRole('spinbutton', { name: '聊天字号 · 像素', exact: true })
  await font.fill('')
  await font.press('2')
  await expect(font).toHaveValue('2')
  await font.press('4')
  await expect(font).toHaveValue('24')
  await page.getByRole('spinbutton', { name: '界面字号 · 像素', exact: true }).fill('18')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.setViewportSize({ width: 320, height: 568 })
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
  expect(measurements.input).toBeLessThanOrEqual(140)
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeInViewport()
  await page.reload()
  await expect(input).toHaveValue(longDraft)
  await expect(page.getByRole('button', { name: '人设管理', exact: true })).toBeInViewport()
  await page.setViewportSize({ width: 667, height: 375 })
  await page.getByRole('button', { name: '人设管理', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存人设', exact: true })).toBeInViewport()
  await expect(page.getByRole('textbox', { name: '姓名', exact: true })).toBeInViewport()
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
