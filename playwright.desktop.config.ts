import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/desktop',
  outputDir: 'test-results/desktop',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
})
