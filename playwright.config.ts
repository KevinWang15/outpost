import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/browser',
  // Cold Vite modules can take longer when Docker suites run at the same time.
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:4178', viewport: { width: 1440, height: 1000 }, headless: true,
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  webServer: { command: 'npm run dev:client -- --port 4178 --strictPort', url: 'http://127.0.0.1:4178', reuseExistingServer: false },
})
