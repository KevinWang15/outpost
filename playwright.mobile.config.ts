import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config'

export default defineConfig(base, {
  testIgnore: [],
  testMatch: '**/mobile/*.spec.ts',
  outputDir: 'test-results/mobile',
  projects: [
    {
      name: 'android-chromium',
      use: { ...devices['Pixel 7'], channel: 'chromium', launchOptions: { args: ['--disable-webgl'] } },
    },
    { name: 'iphone-webkit', use: { ...devices['iPhone 13'], launchOptions: {} } },
    { name: 'ipad-webkit', use: { ...devices['iPad (gen 7)'], launchOptions: {} } },
  ],
})
