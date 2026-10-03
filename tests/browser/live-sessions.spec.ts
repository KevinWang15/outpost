import { codingIdentity } from './session-fixture'
import { healthySoftware } from './software-fixture'
import { expect, test, type Route } from '@playwright/test'
import type { Target, Session } from '../../shared/session-manager'

const targets: Target[] = ['alpha', 'beta'].map(id => ({
  id, backends: ['dtach'], name: `${id} target`, tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: `${id}.example`, createdAt: '2026-09-29T00:00:00Z',
  // beta deliberately has no saved environment: its list must still be read live.
  ...(id === 'alpha' ? { environment: { home: '/root', platform: 'linux', username: 'root', uid: 0, shell: '/bin/bash',  } } : {}),
}))
function sessionList(name: string) {
  const session: Session = { ...codingIdentity('codex', 'fixture-session'),
    env: {}, args: '',
    id: 'fixture-session', name, rootDir: '/root/project', createdAt: '2026-09-29T00:00:00Z',
    backend: 'dtach', tool: 'codex', lastConnectedAt: null, activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: 'idle', socketPath: '/root/.outpost/sockets/fixture.sock',
  }
  return { sessions: [session], registryPath: '/root/.outpost/sessions.json' }
}

test('every target click, manual refresh, and reload reads live without browser caching', async ({ page }) => {
  const reads: Record<string, number> = { alpha: 0, beta: 0 }
  await page.addInitScript(() => {
    const modes: RequestCache[] = []
    Object.defineProperty(window, 'sessionFetchModes', { value: modes })
    const fetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      if (String(input).endsWith('/sessions')) modes.push(init?.cache ?? 'default')
      return fetch(input, init)
    }
  })
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/auth/session') return route.fulfill({ json: { mode: 'local', user: null } })
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware([path.includes('beta') || path.includes('dtach') ? 'dtach' : 'tmux']) })
    if (path === '/api/targets') return route.fulfill({ json: targets })
    const id = path.split('/')[3]
    await route.fulfill({ json: sessionList(`${id} live ${++reads[id]}`) })
  })
  await page.goto('/?target=beta')
  await expect(page.getByText('beta live 1', { exact: true })).toBeVisible()
  await page.getByRole('navigation').getByRole('button', { name: 'beta target', exact: true }).click()
  await expect(page.getByText('beta live 2', { exact: true })).toBeVisible()
  await expect(page.getByText('beta live 1', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click()
  await expect(page.getByText('beta live 3', { exact: true })).toBeVisible()
  await page.getByRole('navigation').getByRole('button', { name: 'alpha target', exact: true }).click()
  await expect(page.getByText('alpha live 1', { exact: true })).toBeVisible()
  await page.getByRole('navigation').getByRole('button', { name: 'beta target', exact: true }).click()
  await expect(page.getByText('beta live 4', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\?target=beta$/)
  await page.reload()
  await expect(page.getByText('beta live 5', { exact: true })).toBeVisible()
  expect(reads).toEqual({ alpha: 1, beta: 5 })
  const modes = await page.evaluate(() => (window as typeof window & { sessionFetchModes: RequestCache[] }).sessionFetchModes)
  expect(modes.length).toBeGreaterThan(0)
  expect(modes.every(mode => mode === 'no-store')).toBe(true)
})

test('a new click supersedes a pending read and ignores its older response', async ({ page }) => {
  let reads = 0
  let delayed: Route | undefined
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/auth/session') return route.fulfill({ json: { mode: 'local', user: null } })
    if (new URL(route.request().url()).pathname.endsWith('/software')) return route.fulfill({ json: healthySoftware(['dtach']) })
    if (new URL(route.request().url()).pathname === '/api/targets') return route.fulfill({ json: targets })
    if (++reads === 2) { delayed = route; return }
    await route.fulfill({ json: sessionList(`live result ${reads}`) })
  })
  await page.goto('/?target=alpha')
  await expect(page.getByText('live result 1', { exact: true })).toBeVisible()
  const target = page.getByRole('navigation').getByRole('button', { name: 'alpha target', exact: true })
  await target.click()
  await expect(page.getByRole('status')).toContainText('Fetching sessions from the target')
  await expect(page.getByText('live result 1', { exact: true })).toHaveCount(0)
  await expect.poll(() => reads).toBe(2)
  await target.click()
  await expect(page.getByText('live result 3', { exact: true })).toBeVisible()
  await delayed!.fulfill({ json: sessionList('obsolete result') })
  await expect(page.getByText('obsolete result', { exact: true })).toHaveCount(0)
  await expect(page.getByText('live result 3', { exact: true })).toBeVisible()
})

test('a failed live refresh shows an error instead of a previous session list', async ({ page }) => {
  let reads = 0
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/auth/session') return route.fulfill({ json: { mode: 'local', user: null } })
    if (new URL(route.request().url()).pathname.endsWith('/software')) return route.fulfill({ json: healthySoftware(['dtach']) })
    if (new URL(route.request().url()).pathname === '/api/targets') return route.fulfill({ json: targets })
    if (++reads === 2) return route.fulfill({ status: 502, json: { message: 'Target is unreachable' } })
    await route.fulfill({ json: sessionList(`target result ${reads}`) })
  })
  await page.goto('/?target=alpha')
  await expect(page.getByText('target result 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Target is unreachable')
  await expect(page.getByText('target result 1', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Retry fetching sessions' }).click()
  await expect(page.getByText('target result 3', { exact: true })).toBeVisible()
})
