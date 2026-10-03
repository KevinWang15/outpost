import { expect, test, type Page } from '@playwright/test'
import type { Session, SessionActivity, Target } from '../../shared/session-manager'
import { codingIdentity } from './session-fixture'
import { healthySoftware } from './software-fixture'

const target: Target = { id: 'activity', kind: 'ssh', name: 'Activity', host: 'dev.example.com', backends: ['tmux', 'dtach'], tools: ['codex', 'claude', 'kimi'], createdAt: '2026-10-01T00:00:00Z' }
const idle: SessionActivity = { state: 'idle', updatedAt: null, completionId: null, detail: null }
function session(name: string, tool: Session['tool'], activity: SessionActivity): Session {
  return { ...codingIdentity(tool, name), id: name, name, tool, activity, backend: tool === 'kimi' ? 'dtach' : 'tmux',
    rootDir: '/home/dev/project', createdAt: target.createdAt, lastConnectedAt: target.createdAt, status: 'detached', env: {}, args: '', socketPath: `/home/dev/.outpost/sockets/${name}.sock` }
}
async function fixture(page: Page, options: { newer?: boolean; fail?: boolean } = {}) {
  const sessions = [session('Codex work', 'codex', { ...idle, state: 'working' }), session('Claude idle', 'claude', idle),
    session('Kimi done', 'kimi', { ...idle, state: 'finished', completionId: 'a'.repeat(64) })]
  const checks: unknown[] = []
  let reads = 0
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/auth/session') return route.fulfill({ json: { mode: 'local', user: null } })
    const path = new URL(route.request().url()).pathname
    if (path === '/api/targets') return route.fulfill({ json: [target] })
    if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware(['tmux', 'dtach']) })
    if (path.endsWith('/sessions')) {
      reads++
      return route.fulfill({ json: { sessions, registryPath: '/home/dev/.outpost/sessions.json' } })
    }
    if (path.endsWith('/acknowledge')) {
      checks.push(route.request().postDataJSON())
      if (options.fail) return route.fulfill({ status: 502, json: { message: 'Target is unreachable' } })
      sessions[2].activity = options.newer ? { ...idle, state: 'finished', completionId: 'b'.repeat(64) } : idle
      return route.fulfill({ json: sessions[2] })
    }
    return route.fulfill({ status: 404 })
  })
  await page.goto('/?target=activity')
  await expect(page.getByText('Kimi done', { exact: true })).toBeVisible()
  return { sessions, checks, reads: () => reads }
}

test('shows three AI states separately from terminal status and acknowledges only the displayed completion', async ({ page }) => {
  const state = await fixture(page)
  await expect(page.getByText('AI working', { exact: true })).toBeVisible()
  await expect(page.getByText('Idle', { exact: true })).toHaveCount(1)
  await expect(page.getByText('Detached', { exact: true })).toHaveCount(3)
  const checked = page.getByRole('button', { name: 'Mark Kimi done as checked' })
  await expect(checked).toContainText('Awaiting you')
  await checked.focus()
  await checked.press('Enter')
  await expect(checked).toHaveCount(0)
  await expect(page.getByText('Idle', { exact: true })).toHaveCount(2)
  expect(state.checks).toEqual([{ completionId: 'a'.repeat(64) }])
  expect(state.reads()).toBeGreaterThan(1)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('a newer completion remains unread after a stale acknowledgement and failed checks preserve notices', async ({ page }) => {
  const state = await fixture(page, { newer: true })
  await page.getByRole('button', { name: 'Mark Kimi done as checked' }).click()
  await expect.poll(state.reads).toBe(2)
  await expect(page.getByRole('button', { name: 'Mark Kimi done as checked' })).toContainText('Awaiting you')
  expect(state.checks).toEqual([{ completionId: 'a'.repeat(64) }])
})

test('unavailable native signals are explicit and failed acknowledgements keep the badge', async ({ page }) => {
  const state = await fixture(page, { fail: true })
  state.sessions[0].activity = { ...idle, detail: 'Native transcript cannot be read' }
  await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click()
  await expect(page.getByText('Activity unavailable', { exact: true })).toHaveAttribute('title', 'Native transcript cannot be read')
  await page.getByRole('button', { name: 'Mark Kimi done as checked' }).click()
  await expect(page.getByRole('alert')).toContainText('Target is unreachable')
  await expect(page.getByRole('button', { name: 'Mark Kimi done as checked' })).toBeEnabled()
  await expect(page.getByText('Awaiting you', { exact: true })).toBeVisible()
})
