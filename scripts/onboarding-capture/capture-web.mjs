// Capture deterministic 2x Web UI screenshots for the Outpost onboarding guide
// against a real disposable local-mode backend (`tests/browser/server.ts`) and Vite frontend.
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const apiPort = Number(process.env.OUTPOST_ONBOARDING_API_PORT ?? 4195)
const webPort = apiPort + 1
const outDir = resolve(process.env.OUTPOST_ONBOARDING_SCREENSHOTS ?? 'docs/onboarding')
await mkdir(outDir, { recursive: true })

const processes = [
  spawn('node', ['--import', 'tsx', 'tests/browser/server.ts'], {
    env: { ...process.env, PORT: String(apiPort) },
    stdio: 'inherit',
  }),
  spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
    env: { ...process.env, API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
    stdio: 'ignore',
  }),
]

const stop = () => {
  for (const child of processes) {
    try {
      child.kill('SIGTERM')
    } catch {
      // Ignore already exited child.
    }
  }
}
process.on('exit', stop)

async function waitReady(url) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // Server still booting.
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
  throw new Error(`${url} did not start in time`)
}

async function apiCall(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api${path}`, {
    method,
    headers: {
      'x-outpost-request': '1',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
  return response.status === 204 ? null : response.json()
}

try {
  await waitReady(`http://127.0.0.1:${apiPort}/health`)
  await waitReady(`http://127.0.0.1:${webPort}/`)

  // Seed one clean fixture Linux workstation and three realistic AI sessions.
  const target = await apiCall('POST', '/targets', {
    kind: 'local',
    name: 'Workstation',
  })
  const { environment } = await apiCall('GET', `/targets/${target.id}/software`)
  for (const [name, rootDir, tool] of [
    ['Billing API refactor', '~/projects/billing-api', 'claude'],
    ['API rate limiter', '~/projects/api-gateway', 'codex'],
    ['Release checklist', '~/projects/docs', 'kimi'],
  ]) {
    await apiCall('POST', `/targets/${target.id}/sessions`, {
      name,
      rootDir,
      tool,
      createDirectory: true,
    })
  }

  // Create a real desktop sign-in authorization request so we can capture the live approval UI.
  const authReq = await apiCall('POST', '/desktop/authorizations', {
    challenge: 'A'.repeat(43),
    state: 'B'.repeat(43),
  })

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })

  const neutral = { username: 'dev', home: '/home/dev' }
  const neutralizeApi = async route => {
    const response = await route.fetch()
    if (!(response.headers()['content-type'] ?? '').includes('application/json')) {
      return route.fulfill({ response })
    }
    const raw = await response.text()
    const body = raw
      .replaceAll(JSON.stringify(environment.home).slice(1, -1), neutral.home)
      .replaceAll(`"username":${JSON.stringify(environment.username)}`, `"username":"${neutral.username}"`)
    await route.fulfill({ response, body })
  }

  const context = await browser.newContext({
    viewport: { width: 1320, height: 820 },
    deviceScaleFactor: 2,
  })
  await context.addInitScript(() => {
    globalThis.localStorage.setItem('outpost.onboarding.dismissed', '1')
  })

  const page = await context.newPage()
  await page.route('**/api/**', neutralizeApi)

  // 1. Machines workspace overview (software readiness + AI sessions)
  await page.goto(`http://127.0.0.1:${webPort}/?target=${target.id}`, { waitUntil: 'load' })
  await page.getByRole('row').filter({ hasText: 'Billing API refactor' }).waitFor()
  await page.locator('.card.software.ready').waitFor()
  await page.waitForTimeout(250)
  await page.screenshot({ path: resolve(outDir, 'web-workspace.png') })

  // 2. Add a machine wizard (Step 1: SSH vs Outbound tunnel)
  await page.getByRole('button', { name: 'Add a machine' }).click()
  await page.locator('dialog[open]').waitFor()
  await page.waitForTimeout(200)
  await page.screenshot({ path: resolve(outDir, 'web-add-machine.png') })
  await page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click()
  await page.locator('dialog[open]').waitFor({ state: 'detached' })

  // 3. New session dialog (tool picker + project directory)
  await page.getByRole('button', { name: 'New session' }).click()
  await page.locator('dialog[open]').waitFor()
  await page.locator('dialog[open] input[name="name"]').fill('Billing API refactor')
  await page.locator('dialog[open] input[name="rootDir"]').fill('~/projects/billing-api')
  await page.waitForTimeout(200)
  await page.screenshot({ path: resolve(outDir, 'web-new-session.png') })
  await page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click()
  await page.locator('dialog[open]').waitFor({ state: 'detached' })

  // 4. Connect dialog (Outpost Desktop vs Web terminal)
  await page.getByRole('button', { name: 'Connect', exact: true }).first().click()
  await page.locator('dialog[open]').waitFor()
  await page.waitForTimeout(200)
  await page.screenshot({ path: resolve(outDir, 'web-connect-dialog.png') })
  await page.locator('dialog[open]').getByRole('button', { name: 'Close dialog' }).click()
  await page.locator('dialog[open]').waitFor({ state: 'detached' })

  // 5. Browser desktop authorization screen (/desktop/authorize)
  await page.goto(`http://127.0.0.1:${webPort}/desktop/authorize?request=${authReq.requestId}`, {
    waitUntil: 'load',
  })
  await page.getByRole('button', { name: 'Connect app' }).waitFor()
  // Neutralize localhost capture origin to match desktop screenshots (`https://outpost.example.com`).
  await page.evaluate(origin => {
    for (const el of globalThis.document.querySelectorAll('strong')) {
      if (el.textContent?.trim() === origin) el.textContent = 'https://outpost.example.com'
    }
  }, `http://127.0.0.1:${webPort}`)
  await page.waitForTimeout(200)
  await page.screenshot({ path: resolve(outDir, 'web-desktop-authorize.png') })

  await browser.close()
  console.log(`Saved 5 Web UI onboarding screenshots to ${outDir}`)
} finally {
  stop()
}
