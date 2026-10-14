// Refresh README images from the real app: a local-mode backend whose target is
// a disposable home with fixture coding tools (tests/browser/server.ts).
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { chromium, devices } from '@playwright/test'

const api = Number(process.env.OUTPOST_SCREENSHOT_PORT ?? 4193),
  web = api + 1
const images = new URL('../docs/images/', import.meta.url)
const processes = [
  spawn('node', ['--import', 'tsx', 'tests/browser/server.ts'], {
    env: { ...process.env, PORT: String(api) },
    stdio: 'inherit',
  }),
  spawn('npx', ['vite', '--port', String(web), '--strictPort'], {
    env: { ...process.env, API_PROXY_TARGET: `http://127.0.0.1:${api}` },
    stdio: 'ignore',
  }),
]
const stop = () => processes.forEach(child => child.kill())
process.on('exit', stop)

async function ready(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      /* Not listening yet. */
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`${url} did not start`)
}
const call = async (method, path, body) => {
  const response = await fetch(`http://127.0.0.1:${api}/api${path}`, {
    method,
    headers: { 'x-outpost-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body && JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${method} ${path}: ${await response.text()}`)
  return response.status === 204 ? null : response.json()
}

try {
  await ready(`http://127.0.0.1:${api}/health`)
  await ready(`http://127.0.0.1:${web}/`)
  const target = await call('POST', '/targets', {
    kind: 'local',
    name: 'Workstation',
    tools: ['claude', 'codex', 'kimi'],
  })
  await call('GET', `/targets/${target.id}/software`)
  for (const [name, rootDir, tool] of [
    ['Billing API refactor', '~/projects/billing-api', 'claude'],
    ['Onboarding flow', '~/projects/web-app', 'codex'],
    ['Release notes', '~/projects/web-app', 'kimi'],
  ]) {
    await call('POST', `/targets/${target.id}/sessions`, { name, rootDir, tool, createDirectory: true })
  }
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 2 })
  await page.setContent(
    (await readFile(new URL('./banner.html', import.meta.url), 'utf8')).replace(
      'src="/outpost.svg"',
      `src="http://127.0.0.1:${web}/outpost.svg"`,
    ),
  )
  await page.setViewportSize({ width: 1600, height: 560 })
  await page.screenshot({
    path: new URL('banner.png', images).pathname,
    clip: { x: 0, y: 0, width: 1600, height: 560 },
  })
  await page.setViewportSize({ width: 1360, height: 820 })
  await page.goto(`http://127.0.0.1:${web}/?target=${target.id}`)
  await page.getByRole('row').filter({ hasText: 'Billing API refactor' }).waitFor()
  await page.screenshot({ path: new URL('workspace.png', images).pathname })
  await page.getByRole('button', { name: 'Connect' }).first().click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Outpost Desktop/ })
    .waitFor()
  await page.screenshot({ path: new URL('connect.png', images).pathname })
  const opened = page.waitForEvent('popup')
  await page.getByRole('button', { name: /Web terminal/ }).click()
  const terminal = await opened
  await terminal.locator('.terminal-state.connected').waitFor()
  await terminal.waitForTimeout(800)
  await terminal.screenshot({ path: new URL('web-terminal.png', images).pathname })
  const phone = await browser.newPage({ ...devices['iPhone 13'] })
  await phone.goto(`http://127.0.0.1:${web}/?target=${target.id}`)
  await phone.getByRole('row').filter({ hasText: 'Release notes' }).waitFor()
  await phone.screenshot({ path: new URL('phone.png', images).pathname })
  await browser.close()
  console.log('Saved README images to docs/images/')
} finally {
  stop()
}
