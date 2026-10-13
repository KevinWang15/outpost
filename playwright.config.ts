import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:4178', viewport: { width: 1360, height: 900 }, headless: true,
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  webServer: [
    // SIGTERM lets the backend stop its fixture tmux sessions and remove its home.
    { command: 'node --import tsx tests/browser/server.ts', url: 'http://127.0.0.1:4179/health', reuseExistingServer: false, stdout: 'pipe', gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
    { command: 'npx vite --port 4178 --strictPort', url: 'http://127.0.0.1:4178', reuseExistingServer: false, env: { API_PROXY_TARGET: 'http://127.0.0.1:4179' } },
  ],
})
