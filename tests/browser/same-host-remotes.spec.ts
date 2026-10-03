import { codingIdentity } from './session-fixture'
import { healthySoftware } from './software-fixture'
import { expect, test } from '@playwright/test'
import type { Target, Session, SessionBackend } from '../../shared/session-manager'

test('same-host targets show all backend badges and fetch live lists on navigation and reload', async ({ page }) => {
  const backends: SessionBackend[] = ['tmux', 'dtach']
  const targets: Target[] = backends.map(backend => ({
    id: backend, name: `Development ${backend}`, tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev.example.com', backends: [backend],
    createdAt: '2026-09-29T00:00:00Z',
    environment: { home: '/root', platform: 'linux', username: 'root', uid: 0, shell: '/bin/bash' },
  }))
  const sessions: Session[] = backends.map(backend => ({ ...codingIdentity(backend === 'tmux' ? 'kimi' : 'claude', backend),
    env: {}, args: '',
    id: backend, backend, tool: backend === 'tmux' ? 'kimi' : 'claude', name: `${backend} work`, rootDir: `/root/${backend}`,
    createdAt: '2026-09-29T00:00:00Z', lastConnectedAt: '2026-09-29T00:00:00Z',
    activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: 'detached', socketPath: `/root/.outpost/sockets/${backend}.sock`,
  }))
  sessions.push({ ...codingIdentity((sessions[1]).tool, 'dtach-ready'), ...sessions[1], id: 'dtach-ready', name: 'dtach ready', activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: 'idle', lastConnectedAt: null })
  const reads: Record<string, number> = { tmux: 0, dtach: 0 }
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/targets') return route.fulfill({ json: targets })
    const target = targets.find(item => path.startsWith(`/api/targets/${item.id}/`))
    if (!target) return route.fulfill({ status: 404 })
    if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware(target.backends, target.tools) })
    if (!path.endsWith('/sessions')) return route.fulfill({ status: 404 })
    ++reads[target.id]
    await route.fulfill({ json: { sessions, registryPath: '/root/.outpost/sessions.json' } })
  })
  await page.goto('/?target=tmux')
  await expect(page.locator('.target-backend')).toHaveText('Session backends: tmux')
  await expect(page.getByRole('heading', { name: 'Sessions', exact: true })).toBeVisible()
  await expect(page.locator('.session-row')).toHaveCount(3)
  await expect(page.locator('.session-backend-badge')).toHaveText(['tmux', 'dtach', 'dtach'])
  await expect(page.getByText('tmux work', { exact: true })).toBeVisible()
  await expect(page.getByText('dtach work', { exact: true })).toBeVisible()
  await expect(page.locator('.stats-row strong').first()).toHaveText('03')
  await expect(page.locator('.stats-row strong').nth(1)).toHaveText('02')
  for (const backend of backends) {
    await expect(page.getByRole('navigation').getByRole('button', { name: `Development ${backend}`, exact: true })).toContainText(`dev.example.com · ${backend}`)
  }
  await page.screenshot({ path: 'test-results/mixed-backend-sessions.png', fullPage: true })
  await page.getByRole('textbox', { name: 'Search sessions' }).fill('tmux')
  await expect(page.locator('.session-row')).toHaveCount(1)
  await expect(page.locator('.session-backend-badge')).toHaveText('tmux')

  await page.getByRole('navigation').getByRole('button', { name: 'Development dtach', exact: true }).click()
  await expect(page.locator('.target-backend')).toHaveText('Session backends: dtach')
  await expect(page.locator('.session-row')).toHaveCount(3)
  await expect(page.locator('.session-backend-badge')).toHaveText(['tmux', 'dtach', 'dtach'])
  await page.reload()
  await expect(page.locator('.session-row')).toHaveCount(3)
  await expect.poll(() => reads.dtach).toBe(2)
  await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click()
  await expect.poll(() => reads.dtach).toBe(3)
  await page.getByRole('navigation').getByRole('button', { name: 'Development tmux', exact: true }).click()
  await expect(page.locator('.session-row')).toHaveCount(3)
  await expect.poll(() => reads.tmux).toBe(2)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('.target-backend')).toBeVisible()
  await expect(page.locator('.session-backend-badge')).toHaveText(['tmux', 'dtach', 'dtach'])
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/mixed-backend-sessions-mobile.png', fullPage: true })
})
