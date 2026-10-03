/* global document, Image, MutationObserver, NodeFilter, window */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import { demoDate, demoHome, demoSessions, softwareReport, targets } from './demo.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const output = resolve(process.env.OUTPOST_PROMO_CAPTURE_DIR ?? resolve(root, 'promo-v2/assets/screenshots'))
const port = Number(process.env.OUTPOST_PROMO_PORT ?? 4191)
const origin = `http://127.0.0.1:${port}`
const sessions = demoSessions()
const errors = []
const manifest = { fictionalData: true, screenshots: [], requests: {} }
let server, browser

async function checkPrivacy(page) {
  const visible = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const text = []
    let node
    while ((node = walker.nextNode())) {
      if (node.parentElement && !node.parentElement.closest('script, style')) text.push(node.textContent)
    }
    return text.join('\n')
  })
  const forbidden = [
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
    /\/home\/(?!demo\b)[^\s/]+/,
    /\/(?:Users|root)\//,
  ]
  if (forbidden.some(pattern => pattern.test(visible))) throw new Error('Unexpected private content in screenshot; capture refused.')
  const addresses = new Set(targets.filter(target => target.kind === 'ssh').map(target => `root@${target.host}`))
  if ((visible.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).some(address => !addresses.has(address))) throw new Error('Unknown target address in screenshot.')
}

async function capture(page, file, selector) {
  await checkPrivacy(page)
  await page.evaluate(() => document.fonts.ready)
  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
  let pixels = await page.screenshot({ animations: 'disabled', fullPage: true })
  if (selector) {
    const bounds = await page.locator(selector).boundingBox()
    if (!bounds) throw new Error(`Missing capture subject: ${selector}`)
    // Crop the full frame so fractional bounds and viewport edges cannot add or remove pixels.
    const cropped = await page.evaluate(async ({ data, rect }) => {
      const image = new Image()
      image.src = `data:image/png;base64,${data}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(rect.width)
      canvas.height = Math.ceil(rect.height)
      canvas.getContext('2d').drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/png').split(',')[1]
    }, { data: pixels.toString('base64'), rect: { ...bounds, x: bounds.x + scroll.x, y: bounds.y + scroll.y } })
    pixels = Buffer.from(cropped, 'base64')
  }
  await writeFile(resolve(output, file), pixels)
  manifest.screenshots.push({ file, width: pixels.readUInt32BE(16), height: pixels.readUInt32BE(20), sha256: createHash('sha256').update(pixels).digest('hex') })
  console.log(`Captured ${file} with synthetic session data.`)
}

async function fixture(route) {
  const request = route.request(), url = new URL(request.url())
  if (url.origin !== origin) throw new Error('External request during screenshot capture.')
  if (!url.pathname.startsWith('/api/')) return route.continue()
  const key = `${request.method()} ${url.pathname}`
  manifest.requests[key] = (manifest.requests[key] ?? 0) + 1
  if (url.pathname === '/api/targets' && request.method() === 'GET') return route.fulfill({ json: targets })
  const [, , targetId, resource, sessionId, action] = url.pathname.split('/').filter(Boolean)
  const target = targets.find(target => target.id === targetId)
  if (!target) throw new Error('Unknown synthetic target.')
  let result
  if (resource === 'software' && request.method() === 'GET') result = softwareReport()
  else if (resource === 'sessions' && !sessionId && request.method() === 'GET') result = { sessions: sessions[targetId], registryPath: `${demoHome}/.outpost/sessions.json` }
  else if (resource === 'sessions' && action === 'acknowledge' && request.method() === 'POST') {
    const session = sessions[targetId].find(session => session.id === sessionId)
    if (!session) throw new Error('Unknown synthetic session.')
    session.activity = { state: 'idle', updatedAt: demoDate, completionId: null, detail: null }
    result = session
  } else throw new Error(`Unexpected capture request: ${key}`)
  await route.fulfill({ headers: { 'Cache-Control': 'no-store' }, json: result })
}

try {
  await mkdir(output, { recursive: true })
  server = await createServer({ root, server: { host: '127.0.0.1', port, strictPort: true, hmr: false }, logLevel: 'error' })
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', serviceWorkers: 'block' })
  await context.route('**/*', route => fixture(route).catch(error => { errors.push(error.message); return route.abort('blockedbyclient') }))
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(15000)
  await page.clock.install({ time: new Date(demoDate) })
  // Keep the film's simplified presentation confined to this capture browser.
  await page.addInitScript(() => {
    function simplify() {
      for (const label of document.querySelectorAll('.target-nav small, .session-identity small')) {
        const value = label.textContent.split(' · ')[0]
        if (label.textContent !== value) label.textContent = value
      }
      for (const registry of document.querySelectorAll('.registry-stat')) {
        for (const [selector, value] of [['span', 'WORKSPACE'], ['code', 'Atlas development'], ['small', 'Live sessions on this target']]) {
          const label = registry.querySelector(selector)
          if (label && label.textContent !== value) label.textContent = value
        }
      }
      for (const paragraph of document.querySelectorAll('.bottom-note p')) {
        const value = 'Your work stays where it runs. Close the terminal and return to the same session whenever you are ready.'
        if (paragraph.textContent !== value) paragraph.textContent = value
      }
    }
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style')
      style.textContent = '.session-backend-badge,.target-backend{display:none!important}'
      document.head.append(style)
      new MutationObserver(simplify).observe(document.body, { childList: true, subtree: true })
    })
  })
  await page.goto(`${origin}/?target=demo-atlas`)
  await expect(page).toHaveTitle('Outpost')
  await expect(page.getByText('Build the dashboard', { exact: true })).toBeVisible()
  await expect(page.getByText('All good · required software is installed', { exact: true })).toBeVisible()
  await capture(page, 'dashboard.png')
  await capture(page, 'dashboard-focus.png', '.sessions-panel')
  await capture(page, 'activity-before-focus.png', '.sessions-panel')
  await page.getByRole('button', { name: 'Mark Review the API as checked', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Mark Review the API as checked', exact: true })).toHaveCount(0)
  await capture(page, 'activity-checked-focus.png', '.sessions-panel')
  if (errors.length) throw new Error(errors.join('\n'))
  if (!manifest.requests['POST /api/targets/demo-atlas/sessions/demo-api/acknowledge']) throw new Error('The completion-check interaction was not observed.')
  manifest.fixtureSha256 = createHash('sha256').update(await readFile(new URL('./demo.mjs', import.meta.url))).digest('hex')
  await writeFile(resolve(output, 'capture-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log('Captured all four v2 app screenshots.')
} finally {
  await browser?.close()
  await server?.close()
}
