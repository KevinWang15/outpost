/* global document */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import { createApp } from '../../backend/app.ts'
import { TargetStore } from '../../backend/store.ts'
import { captureTime, desktop, service, software, targets } from './demo.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = join(root, 'docs/images')
const state = await mkdtemp(join(tmpdir(), 'outpost-readme-'))
const port = Number(process.env.OUTPOST_README_PORT ?? 4193)
assert(Number.isInteger(port) && port >= 1 && port <= 65535, 'OUTPOST_README_PORT must be a valid port')
const origin = `http://127.0.0.1:${port}`
const errors = []
const requests = new Set()
const screenshots = []
let app, server, browser

async function capture(page, file, selector) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map(image => image.decode()))
    await Promise.all(document.getAnimations()
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})))
  })
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Animation.enable')
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 })
    const { cssContentSize } = await cdp.send('Page.getLayoutMetrics')
    let clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 }
    if (selector) {
      const bounds = await page.locator(selector).boundingBox()
      assert(bounds, `Missing screenshot subject: ${selector}`)
      assert(bounds.height < page.viewportSize().height, 'Dialog must fit inside the capture viewport')
      clip = { x: Math.floor(bounds.x), y: Math.floor(bounds.y), width: Math.ceil(bounds.width), height: Math.ceil(bounds.height), scale: 1 }
    }
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true, clip })
    const pixels = Buffer.from(data, 'base64')
    await writeFile(join(output, file), pixels)
    const item = { file, width: pixels.readUInt32BE(16), height: pixels.readUInt32BE(20), sha256: createHash('sha256').update(pixels).digest('hex') }
    screenshots.push(item)
    console.log(`Captured ${file} with Chrome DevTools Protocol (${item.width} × ${item.height}).`)
  } finally {
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 })
    await cdp.detach()
  }
}

try {
  await mkdir(output, { recursive: true })
  const store = new TargetStore(state)
  for (const target of targets) await store.add(target)
  app = await createApp({ store, service, software, desktop })
  app.addHook('onRequest', async request => { requests.add(`${request.method} ${request.url.split('?')[0]}`) })
  const api = await app.listen({ host: '127.0.0.1', port: 0 })
  const documents = new Map([
    ['/__readme/banner', await readFile(new URL('./banner.html', import.meta.url), 'utf8')],
    ['/__readme/reference', await readFile(new URL('./reference.html', import.meta.url), 'utf8')],
  ])
  server = await createServer({
    root,
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, proxy: { '/api': api, '/health': api } },
    plugins: [{ name: 'readme-documents', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        const html = documents.get(request.url)
        if (!html) return next()
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(html)
      })
    } }],
    logLevel: 'error',
  })
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1180 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', serviceWorkers: 'block' })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`) })
  await page.clock.install({ time: new Date(captureTime) })
  page.setDefaultTimeout(15000)

  await page.setViewportSize({ width: 1600, height: 560 })
  await page.goto(`${origin}/__readme/banner`)
  await capture(page, 'banner.png')
  await page.setViewportSize({ width: 720, height: 420 })
  await page.goto(`${origin}/__readme/reference`)
  await capture(page, 'dashboard-concept.png')

  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${origin}/?target=readme-atlas`)
  await expect(page).toHaveTitle('Outpost')
  await expect(page.getByText('Build the dashboard', { exact: true })).toBeVisible()
  await expect(page.getByText('All good · required software is installed', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mark Review the API as checked', exact: true })).toBeVisible()
  await capture(page, 'workspace.png')

  await page.setViewportSize({ width: 1440, height: 1180 })
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByRole('textbox', { name: 'Session name', exact: true }).fill('Refresh the dashboard')
  await page.getByRole('combobox', { name: 'Coding tool', exact: true }).selectOption('claude')
  await page.getByRole('combobox', { name: 'Root directory', exact: true }).fill('/srv/projects/dashboard')
  await expect(page.getByRole('option', { name: '/srv/projects/dashboard/', exact: true })).toBeVisible()
  await capture(page, 'create-session.png', 'dialog')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()

  await page.getByRole('button', { name: 'Find coding sessions', exact: true }).click()
  await page.getByRole('textbox', { name: 'Conversation keyword', exact: true }).fill('retry')
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.getByText('2 matching conversations', { exact: true })).toBeVisible()
  await capture(page, 'conversation-search.png', 'dialog')
  await page.getByRole('button', { name: 'Done', exact: true }).click()

  await page.getByRole('button', { name: 'Attach an image to Build the dashboard', exact: true }).click()
  await page.getByLabel('Choose image file').setInputFiles(join(output, 'dashboard-concept.png'))
  await expect(page.getByAltText('Clipboard image preview')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send to session', exact: true })).toBeEnabled()
  await capture(page, 'image-attachment.png', 'dialog')
  await page.getByRole('button', { name: 'Send to session', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('pasted into the session input')
  await page.getByRole('button', { name: 'Done', exact: true }).click()

  for (const endpoint of ['GET /api/targets', 'GET /api/targets/readme-atlas/software', 'GET /api/targets/readme-atlas/sessions', 'GET /api/targets/readme-atlas/directories', 'POST /api/targets/readme-atlas/coding-sessions/search', 'POST /api/targets/readme-atlas/sessions/readme-dashboard/image']) assert(requests.has(endpoint), `Missing local API interaction: ${endpoint}`)
  assert.deepEqual(errors, [], 'Browser capture must complete without errors')
  await writeFile(join(output, 'capture-manifest.json'), JSON.stringify({ protocol: 'Chrome DevTools Protocol / Page.captureScreenshot', stack: 'Vite frontend + Fastify API', mockData: true, captureTime, screenshots, requests: [...requests].sort() }, null, 2) + '\n')
  console.log('README captures complete using the local Vite and Fastify stack with example data.')
} finally {
  await browser?.close()
  await server?.close()
  await app?.close()
  await rm(state, { recursive: true, force: true })
}
