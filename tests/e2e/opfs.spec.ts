import { readFile } from 'node:fs/promises'
import { expect, type Page } from '@playwright/test'
import { test } from './fixtures'

const pngDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9kAAAAASUVORK5CYII='
const background = (page: Page) =>
  page.evaluate(() => document.documentElement.style.getPropertyValue('--background-image'))
async function upload(page: Page) {
  await page.getByLabel('背景图片', { exact: true }).setInputFiles({
    name: 'background.png',
    mimeType: 'image/png',
    buffer: Buffer.from(pngDataUrl.split(',')[1], 'base64'),
  })
  await expect.poll(() => background(page)).toContain('blob:')
  await expect(page.getByLabel('背景图片', { exact: true })).toBeEnabled()
}

test('背景上传、替换、刷新和删除保留 OPFS 备份并释放预览 URL', async ({ page }) => {
  await page.goto('./')
  await page.getByRole('button', { name: '外观设置', exact: true }).click()
  await upload(page)
  const first = await background(page)
  await page.getByLabel('背景透明度').press('ArrowRight')
  expect(await background(page)).toBe(first)
  await upload(page)
  await expect.poll(() => background(page)).toBe(first)
  await page.reload()
  await expect.poll(() => background(page)).toContain('blob:')
  await page.getByRole('button', { name: '外观设置', exact: true }).click()
  await page.getByRole('button', { name: '移除背景', exact: true }).click()
  await expect.poll(() => background(page)).toBe('none')
  await page.reload()
  await expect.poll(() => background(page)).toBe('none')
})

test('完整 v3 导出包含图片字节，替换导入后恢复背景预览', async ({ page }) => {
  await page.goto('./')
  await page.getByRole('button', { name: '外观设置', exact: true }).click()
  await upload(page)
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '存档管理', exact: true }).click()
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出全部', exact: true }).click()
  const download = await downloading
  const data = JSON.parse(await readFile((await download.path())!, 'utf8'))
  expect(data.version).toBe(3)
  expect(data.settings.bgImage).toBe(pngDataUrl)
  await page.getByLabel('导入存档文件').setInputFiles({
    name: 'background-v3.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(data)),
  })
  await page
    .getByRole('dialog', { name: '导入并替换当前资料？', exact: true })
    .getByRole('button', { name: '确认', exact: true })
    .click()
  await page.reload()
  await expect.poll(() => background(page)).toContain('blob:')
})
