import { catalogFixture } from '../model-catalog-fixture'
import { test as base } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// WebKit's ephemeral data store exposes OPFS but rejects getDirectory(). A fresh
// persistent profile exercises real filesystem storage and stays isolated per test.
export const test = base.extend({
  context: [
    async (
      {
        browserName,
        playwright,
        browser,
        contextOptions,
        baseURL,
        headless,
        launchOptions,
        viewport,
        userAgent,
        deviceScaleFactor,
        isMobile,
        hasTouch,
      },
      provide,
    ) => {
      const directory =
        browserName === 'webkit' ? await mkdtemp(join(tmpdir(), 'yanju-webkit-')) : undefined
      const options = {
        ...contextOptions,
        baseURL,
        viewport,
        userAgent,
        deviceScaleFactor,
        isMobile,
        hasTouch,
        acceptDownloads: true,
      }
      const context = directory
        ? await playwright.webkit.launchPersistentContext(directory, {
            ...launchOptions,
            ...options,
            headless,
          })
        : await browser.newContext(options)
      try {
        // Business acceptance must not wait for external font delivery.
        await context.route('https://models.dev/api.json', (route) =>
          route.fulfill({ json: catalogFixture() }),
        )
        await context.route('https://fonts.googleapis.com/**', (route) =>
          route.fulfill({ contentType: 'text/css', body: '' }),
        )
        if (directory) {
          // WebKit may share origin filesystem data across otherwise separate profiles.
          // Clear only this application's test data before seeding the scenario.
          const reset = await context.newPage()
          await reset.route('**/fixture-storage-reset', (route) =>
            route.fulfill({
              contentType: 'text/html',
              body: '<!doctype html><title>Test storage reset</title>',
            }),
          )
          await reset.goto(`${baseURL}fixture-storage-reset`)
          await reset.evaluate(async () => {
            for (const key of Object.keys(localStorage))
              if (key.startsWith('yanju_') || key === 'test-seeded') localStorage.removeItem(key)
            await new Promise<void>((resolve, reject) => {
              const request = indexedDB.deleteDatabase('yanju-v3')
              request.onsuccess = () => resolve()
              request.onerror = () => reject(request.error)
              request.onblocked = () => reject(new Error('测试工作数据库仍有连接'))
            })
            const root = await navigator.storage.getDirectory()
            try {
              await root.removeEntry('yanju-v3', { recursive: true })
            } catch (error) {
              if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error
            }
          })
          await reset.close()
        }
        await provide(context)
      } finally {
        await context.close()
        if (directory) await rm(directory, { recursive: true, force: true })
      }
    },
    // Keep real OPFS profile setup and cleanup outside the user workflow's timeout.
    { scope: 'test', timeout: 30_000 },
  ],
})
