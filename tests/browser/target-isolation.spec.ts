import { desktopAvailability } from './terminal-fixture'
import { codingIdentity } from './session-fixture'
import { healthySoftware, executionEnvironment } from './software-fixture'
import { expect, test, type Route } from '@playwright/test'
import type { SessionList, Target } from '../../shared/session-manager'

const metadata = executionEnvironment
const targets: Target[] = ['alpha', 'beta'].map(id => ({ id, tools: ['codex', 'kimi', 'claude'], kind: 'ssh', name: id, host: id, backends: ['tmux'], createdAt: '2026-09-30T00:00:00Z', environment: metadata }))
const sessions = (id: string): SessionList => ({ sessions: [{ ...codingIdentity('codex', `${id}-session`), env: {}, args: '', socketPath: `/root/.outpost/sockets/${id}.sock`, id: `${id}-session`, name: `${id} work`, rootDir: '/root/project', tool: 'codex', backend: 'tmux', activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: 'idle', lastConnectedAt: null, createdAt: '2026-09-30T00:00:00Z' }], registryPath: '/root/.outpost/sessions.json' })
const nextPaint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

test('creating a session after leaving its target cannot overwrite another target or trigger an obsolete read', async ({ page }) => {
  let pending: Route | undefined
  const reads: string[] = []
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware() })
    if (path === '/api/targets') return route.fulfill({ json: targets })
    if (path.endsWith('/sessions') && route.request().method() === 'POST') { pending = route; return }
    if (path.endsWith('/directories')) return route.fulfill({ json: { directories: [], truncated: false } })
    const id = path.split('/')[3]
    reads.push(id)
    return route.fulfill({ json: sessions(id) })
  })
  await page.goto('/?target=alpha')
  await expect(page.getByText('alpha work', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'New session' }).click()
  await page.getByRole('textbox', { name: 'Session name' }).fill('new work')
  await page.getByRole('combobox', { name: 'Root directory' }).fill('/root')
  await page.getByRole('dialog').getByRole('button', { name: 'Create session', exact: true }).click()
  await expect.poll(() => !!pending).toBe(true)
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await page.getByRole('navigation').getByRole('button', { name: 'beta', exact: true }).click()
  await expect(page.getByText('beta work', { exact: true })).toBeVisible()
  const completed = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/sessions'))
  await pending!.fulfill({ json: sessions('alpha').sessions[0] })
  await (await completed).finished()
  await page.evaluate(nextPaint)
  await expect(page.getByText('beta work', { exact: true })).toBeVisible()
  await expect(page.getByText('alpha work', { exact: true })).toHaveCount(0)
  expect(reads).toEqual(['alpha', 'beta'])
})

test('leaving a target cancels its pending connection dialog', async ({ page }) => {
  let pending: Route | undefined, cancelled = false
  page.on('requestfailed', request => { if (request.url().endsWith('/connect')) cancelled = true })
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware() })
    if (path === '/api/targets') return route.fulfill({ json: targets })
    if (path.endsWith('/connect')) { pending = route; return }
    return route.fulfill({ json: sessions(path.split('/')[3]) })
  })
  await page.goto('/?target=alpha')
  await page.getByRole('button', { name: /^Connection options for / }).click()
  await expect.poll(() => !!pending).toBe(true)
  await page.getByRole('navigation').getByRole('button', { name: 'beta', exact: true }).click()
  await expect.poll(() => cancelled).toBe(true)
  await pending!.fulfill({ json: { commands: { bash: 'obsolete' }, expiresAt: '2026-09-30T00:00:00Z', desktop: desktopAvailability() } }).catch(() => {})
  await page.evaluate(nextPaint)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('beta work', { exact: true })).toBeVisible()
})

test('a late session creation cannot discard a newer draft on the same target', async ({ page }) => {
  let pending: Route | undefined
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/targets') return route.fulfill({ json: targets })
    if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware() })
    if (path.endsWith('/directories')) return route.fulfill({ json: { directories: [], truncated: false } })
    if (path.endsWith('/sessions') && route.request().method() === 'POST') { pending = route; return }
    return route.fulfill({ json: sessions('alpha') })
  })
  await page.goto('/?target=alpha')
  await page.getByRole('button', { name: 'New session' }).click()
  await page.getByRole('textbox', { name: 'Session name' }).fill('First request')
  await page.getByRole('combobox', { name: 'Root directory' }).fill('/root')
  await page.getByRole('dialog').getByRole('button', { name: 'Create session', exact: true }).click()
  await expect.poll(() => Boolean(pending)).toBe(true)
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await page.getByRole('button', { name: 'New session' }).click()
  await page.getByRole('textbox', { name: 'Session name' }).fill('Keep my newer draft')
  const completed = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/sessions'))
  await pending!.fulfill({ status: 201, json: sessions('alpha').sessions[0] })
  await (await completed).finished()
  await page.evaluate(nextPaint)
  await expect(page.getByRole('dialog', { name: 'Create a session' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Session name' })).toHaveValue('Keep my newer draft')
})

for (const stage of ['launch', 'fallback'] as const) test(`leaving a target cancels its pending direct ${stage} without showing obsolete notifications or options`, async ({ page }) => {
  let pending: Route | undefined, cancelled = false
  const endpoint = stage === 'launch' ? '/launch' : '/connect'
  page.on('requestfailed', request => { if (request.url().endsWith(endpoint)) cancelled = true })
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/targets') return route.fulfill({ json: targets })
    if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware() })
    if (path.endsWith(endpoint)) { pending = route; return }
    if (path.endsWith('/launch')) return route.fulfill({ status: 409, json: { message: 'No desktop terminal' } })
    return route.fulfill({ json: sessions(path.split('/')[3]) })
  })
  await page.goto('/?target=alpha')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect.poll(() => !!pending).toBe(true)
  await page.getByRole('navigation').getByRole('button', { name: 'beta', exact: true }).click()
  await expect.poll(() => cancelled).toBe(true)
  await pending!.fulfill({ json: stage === 'launch'
    ? { name: 'Terminal', shell: 'bash' }
    : { commands: { bash: 'obsolete' }, expiresAt: targets[0].createdAt, desktop: desktopAvailability() } }).catch(() => {})
  await page.evaluate(nextPaint)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.toast')).toHaveCount(0)
  await expect(page.getByText('beta work', { exact: true })).toBeVisible()
})

test('late software check errors never appear in another target workspace', async ({ page }) => {
  let alpha: Route | undefined
  let alphaChecks = 0
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/targets') return route.fulfill({ json: targets })
    if (path === '/api/targets/alpha/software') {
      if (++alphaChecks === 1) { alpha = route; return }
      return route.fulfill({ status: 502, json: { message: 'Alpha software check failed' } })
    }
    if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware() })
    return route.fulfill({ json: sessions(path.split('/')[3]) })
  })
  await page.goto('/?target=alpha')
  await expect.poll(() => !!alpha).toBe(true)
  await page.getByRole('navigation').getByRole('button', { name: 'beta', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New session' })).toBeEnabled()
  await alpha!.fulfill({ status: 502, json: { message: 'Alpha software check failed' } }).catch(() => {})
  await page.evaluate(nextPaint)
  await expect(page.getByText('Alpha software check failed')).toHaveCount(0)
  await page.getByRole('navigation').getByRole('button', { name: 'alpha', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Alpha software check failed' })).toBeVisible()
})

test('a late target creation preserves the current navigation and a newly opened draft', async ({ page }) => {
  let pending: Route | undefined
  const added = { ...targets[0], id: 'gamma', name: 'gamma', host: 'gamma' }
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/environment') return route.fulfill({ json: { platform: 'linux', supported: true, usesWsl: false } })
    if (path === '/api/targets' && route.request().method() === 'POST') { pending = route; return }
    if (path === '/api/targets') return route.fulfill({ json: targets })
    if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware() })
    return route.fulfill({ json: sessions(path.split('/')[3]) })
  })
  await page.goto('/?target=alpha')
  await expect(page.getByText('alpha work', { exact: true })).toBeVisible()
  await page.locator('.add-target').click()
  await page.getByRole('textbox', { name: 'Target name' }).fill('gamma')
  await page.getByRole('textbox', { name: 'Host or SSH alias' }).fill('gamma')
  await page.getByRole('dialog').getByRole('button', { name: 'Add target', exact: true }).click()
  await expect.poll(() => !!pending).toBe(true)
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await page.getByRole('navigation').getByRole('button', { name: 'beta', exact: true }).click()
  await expect(page.getByText('beta work', { exact: true })).toBeVisible()
  await page.locator('.add-target').click()
  await page.getByRole('textbox', { name: 'Target name' }).fill('Next draft')
  const completed = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/targets'))
  await pending!.fulfill({ status: 201, json: added })
  await (await completed).finished()
  await page.evaluate(nextPaint)
  await expect(page.getByRole('textbox', { name: 'Target name' })).toHaveValue('Next draft')
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await expect(page.getByRole('navigation').getByRole('button', { name: 'gamma', exact: true })).toBeVisible()
  await expect(page.getByText('beta work', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\?target=beta$/)
})

test('connecting another session cancels the previous request and keeps the latest dialog', async ({ page }) => {
  let first: Route | undefined, second: Route | undefined, cancelled = false
  const entries = ['first', 'second'].map(id => ({ ...sessions('alpha').sessions[0], id, name: `${id} work` }))
  page.on('requestfailed', request => { if (request.url().endsWith('/first/connect')) cancelled = true })
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/targets') return route.fulfill({ json: targets })
    if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware() })
    if (path.endsWith('/first/connect')) { first = route; return }
    if (path.endsWith('/second/connect')) { second = route; return }
    return route.fulfill({ json: { sessions: entries, registryPath: '/root/.outpost/sessions.json' } })
  })
  await page.goto('/?target=alpha')
  await page.locator('.session-row').filter({ hasText: 'first work' }).getByRole('button', { name: /^Connection options for / }).click()
  await expect.poll(() => !!first).toBe(true)
  await page.locator('.session-row').filter({ hasText: 'second work' }).getByRole('button', { name: /^Connection options for / }).click()
  await expect.poll(() => !!second).toBe(true)
  await expect.poll(() => cancelled).toBe(true)
  const connection = (command: string) => ({ commands: { bash: command }, expiresAt: targets[0].createdAt, desktop: desktopAvailability() })
  await second!.fulfill({ json: connection('second-session-command') })
  await expect(page.getByRole('dialog', { name: 'Connect to second work' })).toBeVisible()
  await first!.fulfill({ json: connection('obsolete-first-command') }).catch(() => {})
  await page.evaluate(nextPaint)
  await expect(page.getByRole('dialog', { name: 'Connect to second work' })).toContainText('second-session-command')
  await expect(page.getByText('obsolete-first-command', { exact: true })).toHaveCount(0)
})

for (const destination of ['session', 'finder', 'requirements', 'image', 'remove-session', 'add-target', 'remove-target'] as const) {
  test(`opening ${destination} cancels pending connection options without covering the new dialog`, async ({ page }) => {
    let pending: Route | undefined, cancelled = false
    page.on('requestfailed', request => { if (request.url().endsWith('/connect')) cancelled = true })
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/targets') return route.fulfill({ json: targets })
      if (path === '/api/environment') return route.fulfill({ json: { platform: 'linux', supported: true, usesWsl: false } })
      if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware() })
      if (path.endsWith('/connect')) { pending = route; return }
      if (path.endsWith('/directories')) return route.fulfill({ json: { directories: [], truncated: false } })
      return route.fulfill({ json: sessions('alpha') })
    })
    await page.goto('/?target=alpha')
    await page.getByRole('button', { name: 'Connection options for alpha work' }).click()
    await expect.poll(() => !!pending).toBe(true)
    const titles = {
      session: 'Create a session', finder: 'Find coding sessions', requirements: 'Configure required software',
      image: 'Attach an image', 'remove-session': 'Remove alpha work (tmux)?',
      'add-target': 'Add a target', 'remove-target': 'Remove alpha?',
    }
    switch (destination) {
      case 'session':
        await page.getByRole('button', { name: 'New session' }).click()
        await page.getByRole('textbox', { name: 'Session name' }).fill('Keep this draft')
        break
      case 'finder': await page.getByRole('button', { name: 'Find coding sessions' }).click(); break
      case 'requirements':
        await page.getByRole('button', { name: /Required Software/ }).click()
        await page.getByRole('button', { name: 'Configure required software' }).click()
        break
      case 'image': await page.getByRole('button', { name: 'Attach an image to alpha work' }).click(); break
      case 'remove-session': await page.getByRole('button', { name: 'Delete alpha work' }).click(); break
      case 'add-target': await page.locator('.add-target').click(); break
      case 'remove-target':
        await page.getByRole('button', { name: 'Target actions for alpha' }).click()
        await page.getByRole('menuitem', { name: 'Remove target…' }).click()
        break
    }
    const dialog = page.getByRole('dialog', { name: titles[destination], exact: false })
    await expect(dialog).toBeVisible()
    await expect.poll(() => cancelled).toBe(true)
    await pending!.fulfill({ json: { commands: { bash: 'obsolete-command' }, expiresAt: targets[0].createdAt, desktop: desktopAvailability() } }).catch(() => {})
    await page.evaluate(nextPaint)
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(dialog).toBeVisible()
    if (destination === 'session') await expect(page.getByRole('textbox', { name: 'Session name' })).toHaveValue('Keep this draft')
    await page.getByRole('button', { name: 'Close dialog' }).click()
    await expect(page.getByRole('button', { name: 'Connection options for alpha work' })).toBeEnabled()
    await expect(page.getByText('obsolete-command', { exact: true })).toHaveCount(0)
  })
}

test('opening a session draft cancels the direct-launch fallback and its notification', async ({ page }) => {
  let pending: Route | undefined, cancelled = false
  page.on('requestfailed', request => { if (request.url().endsWith('/connect')) cancelled = true })
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/targets') return route.fulfill({ json: targets })
    if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware() })
    if (path.endsWith('/launch')) return route.fulfill({ status: 409, json: { message: 'No desktop terminal' } })
    if (path.endsWith('/connect')) { pending = route; return }
    if (path.endsWith('/directories')) return route.fulfill({ json: { directories: [], truncated: false } })
    return route.fulfill({ json: sessions('alpha') })
  })
  await page.goto('/?target=alpha')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect.poll(() => !!pending).toBe(true)
  await expect(page.locator('.toast')).toContainText('No desktop terminal')
  await page.getByRole('button', { name: 'New session' }).click()
  await expect.poll(() => cancelled).toBe(true)
  await pending!.fulfill({ json: { commands: { bash: 'obsolete' }, expiresAt: targets[0].createdAt, desktop: desktopAvailability() } }).catch(() => {})
  await page.evaluate(nextPaint)
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await expect(page.getByRole('dialog', { name: 'Create a session' })).toBeVisible()
  await expect(page.locator('.toast')).toHaveCount(0)
})
