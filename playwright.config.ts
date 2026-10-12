import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.YANJU_E2E_PORT ?? 5173)
const baseURL = `http://127.0.0.1:${port}/YanJu/`

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  use: {
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
    reducedMotion: process.env.YANJU_E2E_CORE === '1' ? 'reduce' : 'no-preference',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'firefox',
      testMatch: ['**/provider-cors.spec.ts', '**/providers.spec.ts', '**/output-fallback.spec.ts'],
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'mobile',
      use: {
        ...devices['iPhone 13'],
        defaultBrowserType: 'chromium',
        deviceScaleFactor:
          process.env.YANJU_E2E_CORE === '1' ? 1 : devices['iPhone 13'].deviceScaleFactor,
      },
    },
    { name: 'mobile-safari', workers: 1, use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    command: `pnpm ${process.env.YANJU_E2E_PREVIEW === '1' ? 'preview' : 'dev'} --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
  },
})
