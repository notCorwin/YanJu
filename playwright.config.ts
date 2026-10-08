import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.YANJU_E2E_PORT ?? 5173)
const baseURL = `http://127.0.0.1:${port}/YanJu/`

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 10000 },
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: `pnpm dev --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
  },
})
