import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { pngBase64, pngDataUrl, saveFixture } from '../fixtures'
import type { Settings, SaveFile } from '../../src/lib/types'

async function start(page: Page) {
  await page.goto('./')
  await expect(page.getByRole('button', { name: '进入聊天' })).toBeVisible()
  await page.evaluate(async (data) => {
    const modulePath = '/YanJu/src/lib/db.ts'
    await (await import(modulePath)).importSave(data)
  }, saveFixture)
  await expect(page.getByText('测试读者', { exact: true })).toBeVisible()
}
async function settings(page: Page): Promise<Settings> {
  return page.evaluate(async () => {
    const path = '/YanJu/src/lib/db.ts'
    return (await import(path)).db.settings.get('app')
  })
}
const backgroundToken = (page: Page) =>
  page.evaluate(() => document.documentElement.style.getPropertyValue('--background-image'))
const upload = (page: Page) =>
  page.getByLabel('背景图片', { exact: true }).setInputFiles({
    name: 'background.png',
    mimeType: 'image/png',
    buffer: Buffer.from(pngBase64, 'base64'),
  })
async function fileNames(page: Page, directory: string) {
  return page.evaluate(async (name) => {
    let dir = await navigator.storage.getDirectory()
    dir = await dir.getDirectoryHandle('yanju-v2')
    try {
      dir = await dir.getDirectoryHandle(name)
    } catch {
      return []
    }
    return Array.fromAsync(dir.keys())
  }, directory)
}
async function instrumentation(page: Page) {
  await page.addInitScript(() => {
    const state = { reads: [] as string[], created: [] as string[], revoked: [] as string[] }
    Object.assign(window, { opfsTest: state })
    const getFile = FileSystemFileHandle.prototype.getFile
    FileSystemFileHandle.prototype.getFile = function () {
      state.reads.push(this.name)
      return getFile.call(this)
    }
    const create = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (blob) => {
      const url = create(blob)
      state.created.push(url)
      return url
    }
    const revoke = URL.revokeObjectURL.bind(URL)
    URL.revokeObjectURL = (url) => {
      state.revoked.push(url)
      revoke(url)
    }
  })
}

test('原生 OPFS 背景上传、替换、刷新、删除与 URL 释放，外观修改不重读图片', async ({ page }) => {
  await instrumentation(page)
  await start(page)
  await page.getByRole('button', { name: '外观设置' }).click()
  await upload(page)
  await expect.poll(() => backgroundToken(page)).toContain('blob:')
  expect(
    await page.evaluate(async () => {
      const token = document.documentElement.style.getPropertyValue('--background-image')
      const image = new Image()
      image.src = JSON.parse(token.slice(4, -1))
      await image.decode()
      return [image.naturalWidth, image.naturalHeight]
    }),
  ).toEqual([1, 1])
  await page.screenshot({ path: `test-results/opfs-background-${test.info().project.name}.png` })
  const first = (await settings(page)).bgImageRef!
  expect((await settings(page)).bgImage).toBe('')
  expect(await fileNames(page, 'backgrounds')).toEqual([first.id])
  const url = await backgroundToken(page)
  const readCount = await page.evaluate((id) => {
    const state = (window as unknown as { opfsTest: { reads: string[] } }).opfsTest
    return state.reads.filter((name) => name === id).length
  }, first.id)
  await page.getByRole('spinbutton', { name: '聊天字号' }).fill('18')
  await page.getByLabel('背景透明度', { exact: false }).fill('37')
  await page.getByLabel('背景透明度', { exact: false }).dispatchEvent('input')
  await expect.poll(async () => (await settings(page)).bgOpacity).toBe(37)
  expect(await backgroundToken(page)).toBe(url)
  expect(
    await page.evaluate(
      (id) =>
        (window as unknown as { opfsTest: { reads: string[] } }).opfsTest.reads.filter(
          (name) => name === id,
        ).length,
      first.id,
    ),
  ).toBe(readCount)
  await upload(page)
  await expect.poll(async () => (await settings(page)).bgImageRef?.id).not.toBe(first.id)
  const second = (await settings(page)).bgImageRef!
  await expect.poll(() => backgroundToken(page)).not.toBe(url)
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { opfsTest: { revoked: string[] } }).opfsTest.revoked.length,
      ),
    )
    .toBe(1)
  expect(await fileNames(page, 'backgrounds')).toEqual([second.id])
  await page.reload()
  await expect(page.getByRole('button', { name: '进入聊天' })).toBeVisible()
  await expect.poll(() => backgroundToken(page)).toContain('blob:')
  const byteData = await page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory()
    const dir = await (await root.getDirectoryHandle('yanju-v2')).getDirectoryHandle('backgrounds')
    const file = await (await dir.getFileHandle(id)).getFile()
    return btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())))
  }, second.id)
  expect(byteData).toBe(pngBase64)
  await page.getByRole('button', { name: '外观设置' }).click()
  await page.getByRole('button', { name: '移除背景' }).click()
  await expect.poll(() => backgroundToken(page)).toBe('none')
  expect((await settings(page)).bgImageRef).toBeUndefined()
  expect(await fileNames(page, 'backgrounds')).toEqual([])
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { opfsTest: { revoked: string[] } }).opfsTest.revoked.length,
      ),
    )
    .toBe(1)
  await page.reload()
  await expect.poll(() => backgroundToken(page)).toBe('none')
})

test('完整 v2 JSON 带图片字节，在全新浏览器环境恢复 OPFS 存档', async ({
  page,
  browser,
  baseURL,
}) => {
  await start(page)
  await page.getByRole('button', { name: '外观设置' }).click()
  await upload(page)
  await expect.poll(() => backgroundToken(page)).toContain('blob:')
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: '存档管理' }).click()
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出全部' }).click()
  const path = (await downloading).path()
  const exported: SaveFile = JSON.parse(await readFile((await path)!, 'utf8'))
  expect(exported.version).toBe(2)
  expect(exported.settings.bgImage).toBe(pngDataUrl)
  expect(exported.settings).not.toHaveProperty('bgImageRef')
  expect(exported.settings).not.toHaveProperty('archiveCatalogId')
  expect(exported.messages).toEqual(saveFixture.messages)
  const context = await browser.newContext({ baseURL })
  const fresh = await context.newPage()
  try {
    await fresh.goto('./')
    await expect(fresh.getByRole('button', { name: '进入聊天' })).toBeVisible()
    expect(await fileNames(fresh, 'backgrounds')).toEqual([])
    await fresh.getByRole('button', { name: '存档管理' }).click()
    await fresh.getByLabel('导入存档文件').setInputFiles((await path)!)
    await fresh
      .getByRole('dialog', { name: '导入并替换当前资料？' })
      .getByRole('button', { name: '确认', exact: true })
      .click()
    await expect(fresh.getByText('存档导入完成。渠道须重新测试。')).toBeVisible()
    await expect.poll(() => backgroundToken(fresh)).toContain('blob:')
    await expect(fresh.getByText(saveFixture.messages[0].content)).toBeVisible()
    await fresh.reload()
    await expect(fresh.getByText(saveFixture.messages[0].content)).toBeVisible()
    const result = await fresh.evaluate(async () => {
      const path = '/YanJu/src/lib/db.ts'
      const { db, exportSave } = await import(path)
      return {
        save: await exportSave(),
        tables: db.configuration.tables.map((table: { name: string }) => table.name),
      }
    })
    expect(result.tables.sort()).toEqual(['channels', 'personas', 'settings'])
    expect(result.save.settings.bgImage).toBe(pngDataUrl)
    expect(result.save.messages).toEqual(exported.messages)
    expect((await fileNames(fresh, 'archives')).length).toBe(2)
  } finally {
    await context.close()
  }
})

test('跨标签页替换、导出与存档更新由原生 Web Locks 串行化', async ({ page, context }) => {
  await start(page)
  const other = await context.newPage()
  await other.goto('./')
  await expect(other.getByText('测试读者', { exact: true })).toBeVisible()
  await other.getByRole('button', { name: '存档管理' }).click()
  const barrier = await page.evaluate(async () => {
    const path = '/YanJu/src/lib/file-storage.ts'
    const { storageLockName } = await import(path)
    const state: { release?: () => void; acquired: boolean } = { acquired: false }
    Object.assign(window, { storageBarrier: state })
    void navigator.locks.request(storageLockName, async () => {
      state.acquired = true
      await new Promise<void>((resolve) => {
        state.release = resolve
      })
    })
    return storageLockName
  })
  expect(barrier).toBe('yanju-v2:storage')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { storageBarrier: { acquired: boolean } }).storageBarrier.acquired,
      ),
    )
    .toBe(true)
  await page.getByRole('button', { name: '外观设置' }).click()
  await upload(page)
  await expect(page.getByLabel('背景图片', { exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '移除背景' })).toBeDisabled()
  const exporting = other.evaluate(async () => {
    const path = '/YanJu/src/lib/db.ts'
    return (await import(path)).exportSave()
  })
  await page.evaluate(() =>
    (window as unknown as { storageBarrier: { release: () => void } }).storageBarrier.release(),
  )
  const data: SaveFile = await exporting
  // Either serialization order is valid; no internal reference or missing image is valid.
  expect(['', pngDataUrl]).toContain(data.settings.bgImage)
  expect(data.settings).not.toHaveProperty('bgImageRef')
  await expect.poll(() => backgroundToken(other)).toContain('blob:')
  const [left, right] = await Promise.all(
    [page, other].map((tab, index) =>
      tab.evaluate(async (value) => {
        const path = '/YanJu/src/lib/db.ts'
        const { db } = await import(path)
        await db.mutate(
          async (tx: {
            archives: { update: (id: string, value: { name: string }) => Promise<void> }
          }) => {
            await tx.archives.update(`archive-${value + 1}`, { name: `并发篇章${value}` })
          },
        )
        return true
      }, index),
    ),
  )
  expect(left && right).toBe(true)
  await expect(other.getByText('并发篇章0', { exact: true })).toBeVisible()
  await expect(other.getByText('并发篇章1', { exact: true })).toBeVisible()
  const latest = await other.evaluate(async () => {
    const path = '/YanJu/src/lib/db.ts'
    return (await import(path)).exportSave()
  })
  expect(latest.messages).toEqual(saveFixture.messages)
  expect(latest.settings.bgImage).toBe(pngDataUrl)
  expect(await fileNames(page, 'catalogs')).toHaveLength(1)
  await other.close()
})

test('损坏的 OPFS 目录通过确认导入恢复，卸载界面释放背景 URL', async ({ page }) => {
  await instrumentation(page)
  await start(page)
  await page.evaluate(
    async (data) => {
      const path = '/YanJu/src/lib/db.ts'
      await (await import(path)).importSave(data)
    },
    { ...saveFixture, settings: { ...saveFixture.settings, bgImage: pngDataUrl } },
  )
  await expect.poll(() => backgroundToken(page)).toContain('blob:')
  await page.evaluate(async () => {
    const path = '/YanJu/src/lib/db.ts'
    const { db } = await import(path)
    const settings = await db.settings.get('app')
    await db.storage.write(`yanju-v2/catalogs/${settings.archiveCatalogId}.json`, '{broken')
    const channel = new BroadcastChannel('yanju-v2:changes')
    channel.postMessage('changed')
    channel.close()
  })
  await expect(page.getByRole('heading', { name: '本地资料尚未打开' })).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { opfsTest: { revoked: string[] } }).opfsTest.revoked.length,
      ),
    )
    .toBe(1)
  await page.getByLabel('恢复存档文件').setInputFiles({
    name: 'restore.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saveFixture)),
  })
  await page
    .getByRole('dialog', { name: '导入并替换当前资料？' })
    .getByRole('button', { name: '确认', exact: true })
    .click()
  await expect(page.getByRole('button', { name: '进入聊天' })).toBeVisible()
  await expect.poll(() => backgroundToken(page)).toBe('none')
})

test('缺失图片明确报错且拒绝不完整导出；移除后可继续使用', async ({ page }) => {
  await start(page)
  await page.getByRole('button', { name: '外观设置' }).click()
  await upload(page)
  await expect.poll(() => backgroundToken(page)).toContain('blob:')
  const original = (await settings(page)).bgImageRef!
  await page.evaluate(async (id) => {
    const path = '/YanJu/src/lib/db.ts'
    await (await import(path)).db.storage.remove(`yanju-v2/backgrounds/${id}`)
  }, original.id)
  await page.reload()
  await expect(page.getByText(/背景图片读取失败/)).toBeVisible()
  expect((await settings(page)).bgImageRef).toEqual(original)
  await page.getByRole('button', { name: '关闭提示' }).click()
  await page.getByRole('button', { name: '存档管理' }).click()
  await page.getByRole('button', { name: '导出全部' }).click()
  await expect(page.getByText(/背景图片读取失败/)).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = '/YanJu/src/lib/db.ts'
        try {
          await (await import(path)).exportSave()
          return 'success'
        } catch {
          return 'failure'
        }
      }),
    )
    .toBe('failure')
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: '关闭提示' }).click()
  await page.getByRole('button', { name: '外观设置' }).click()
  await page.getByRole('button', { name: '移除背景' }).click()
  await expect.poll(async () => (await settings(page)).bgImageRef).toBeUndefined()
  await expect.poll(() => backgroundToken(page)).toBe('none')
})

test('不支持 OPFS 或 Web Locks 时显示存储错误，不回退保存存档', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'locks', { value: undefined })
  })
  await page.goto('./')
  await expect(page.getByRole('heading', { name: '本地资料尚未打开' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('OPFS')
  await expect(page.getByRole('button', { name: '进入聊天' })).toHaveCount(0)
  const counts = await page.evaluate(async () => {
    const path = '/YanJu/src/lib/db.ts'
    const { db } = await import(path)
    return {
      settings: await db.settings.count(),
      tables: db.configuration.tables.map((table: { name: string }) => table.name),
    }
  })
  expect(counts.settings).toBe(0)
  expect(counts.tables.sort()).toEqual(['channels', 'personas', 'settings'])
})

test('两个标签页同时首次启动，只创建一个默认篇章和人设', async ({ page, context }) => {
  const other = await context.newPage()
  await Promise.all([page.goto('./'), other.goto('./')])
  await Promise.all(
    [page, other].map((tab) => expect(tab.getByRole('button', { name: '进入聊天' })).toBeVisible()),
  )
  const counts = await page.evaluate(async () => {
    const path = '/YanJu/src/lib/db.ts'
    const { db } = await import(path)
    return {
      archives: await db.archives.count(),
      personas: await db.personas.count(),
      messages: await db.messages.count(),
    }
  })
  expect(counts).toEqual({ archives: 1, personas: 1, messages: 1 })
  expect(await fileNames(page, 'catalogs')).toHaveLength(1)
  expect(await fileNames(page, 'archives')).toHaveLength(1)
  await other.close()
})
