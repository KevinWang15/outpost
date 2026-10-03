import { expect, test, type Page, type Route } from '@playwright/test'
import type { Target } from '../../shared/session-manager'
import { executionEnvironment, healthySoftware } from './software-fixture'

const targets: Target[] = [
  { id: 'alpha', name: 'Alpha', kind: 'ssh', host: 'alpha.example.com', backends: ['tmux'], tools: ['codex'], createdAt: '2026-09-30T00:00:00Z' },
  { id: 'beta', name: 'Beta', kind: 'local', backends: ['dtach'], tools: ['kimi'], environment: executionEnvironment, createdAt: '2026-09-30T00:00:00Z' },
]

async function setup(page: Page, remove?: (route: Route) => Promise<void>) {
  let saved = [...targets]
  const reads: Record<string, number> = { alpha: 0, beta: 0 }
  const writes: string[] = []
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/auth/session') return route.fulfill({ json: { mode: 'local', user: null } })
    const path = new URL(route.request().url()).pathname
    const method = route.request().method()
    if (method !== 'GET') writes.push(`${method} ${path}`)
    if (path === '/api/targets') return route.fulfill({ json: saved })
    const target = targets.find(item => path === `/api/targets/${item.id}` || path.startsWith(`/api/targets/${item.id}/`))
    if (!target) return route.fulfill({ status: 404 })
    if (method === 'DELETE' && path === `/api/targets/${target.id}`) {
      if (remove) return remove(route)
      saved = saved.filter(item => item.id !== target.id)
      return route.fulfill({ status: 204 })
    }
    if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware(target.backends, target.tools) })
    if (path.endsWith('/sessions')) {
      ++reads[target.id]
      return route.fulfill({ json: { sessions: [], registryPath: '/root/.outpost/sessions.json' } })
    }
    return route.fulfill({ status: 404 })
  })
  await page.goto('/?target=alpha')
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toBeVisible()
  await expect.poll(() => reads.alpha).toBe(1)
  return { reads, writes }
}

test('a context menu removes its own unselected target only after confirmation', async ({ page }) => {
  const { reads, writes } = await setup(page)
  const beta = page.getByRole('navigation').getByRole('button', { name: 'Beta', exact: true })
  await expect(page.getByText('Target settings', { exact: true })).toHaveCount(0)
  await beta.click({ button: 'right' })
  await expect(page.getByRole('menu', { name: 'Actions for Beta' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toBeVisible()
  expect(reads.beta).toBe(0)
  await page.screenshot({ path: 'test-results/target-menu-desktop.png', fullPage: true })
  await page.getByRole('menuitem', { name: 'Remove target…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Remove Beta?' })
  await expect(dialog).toContainText('Sessions and running coding tools stay on the target')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Close dialog', exact: true })).toBeFocused()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(writes).toEqual([])
  await beta.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Remove target…', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(beta).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toBeVisible()
  expect(writes).toEqual(['DELETE /api/targets/beta'])
  expect(reads.beta).toBe(0)
})

test('the actions button supports keyboard navigation, dismissal, and fresh target visits', async ({ page }) => {
  const { reads } = await setup(page)
  const trigger = page.getByRole('button', { name: 'Target actions for Beta', exact: true })
  await trigger.focus()
  await trigger.press('Enter')
  await expect(page.getByRole('menuitem', { name: 'Open target', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Remove target…', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.getByRole('heading', { name: 'Alpha', exact: true }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await trigger.focus()
  await trigger.press('Space')
  await page.getByRole('menuitem', { name: 'Open target', exact: true }).press('Enter')
  await expect(page.getByRole('heading', { name: 'Beta', exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\?target=beta$/)
  await expect.poll(() => reads.beta).toBe(1)
  await trigger.click()
  await page.getByRole('menuitem', { name: 'Open target', exact: true }).click()
  await expect.poll(() => reads.beta).toBe(2)
})

test.describe('touch targets', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })
  test('the three-dot menu is reachable by touch and stays inside the viewport', async ({ page }) => {
    const { writes } = await setup(page)
    await page.getByRole('button', { name: 'Target actions for Beta', exact: true }).tap()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    const bounds = await menu.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: 'test-results/target-menu-mobile.png', fullPage: true })
    await menu.getByRole('menuitem', { name: 'Remove target…', exact: true }).tap()
    await expect(page.getByRole('dialog', { name: 'Remove Beta?' })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).tap()
    expect(writes).toEqual([])
  })
})

test('a pending target removal keeps its confirmation and permits retry after failure', async ({ page }) => {
  let pending: Route | undefined, attempts = 0
  const { writes } = await setup(page, async route => {
    if (++attempts === 1) { pending = route; return }
    await route.fulfill({ status: 204 })
  })
  await page.getByRole('button', { name: 'Target actions for Beta', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Remove target…', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click()
  await expect.poll(() => !!pending).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Remove Beta?' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Removing…', exact: true })).toBeDisabled()
  await pending!.fulfill({ status: 503, json: { message: 'Could not save target configuration' } })
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Could not save target configuration')
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Beta', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toBeVisible()
  expect(writes).toEqual(['DELETE /api/targets/beta', 'DELETE /api/targets/beta'])
})

test('removing the selected and final target navigates to the remaining workspace and then overview', async ({ page }) => {
  const { reads, writes } = await setup(page)
  for (const name of ['Alpha', 'Beta']) {
    await page.getByRole('button', { name: `Target actions for ${name}`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Remove target…', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    if (name === 'Alpha') {
      await expect(page.getByRole('heading', { name: 'Beta', exact: true })).toBeVisible()
      await expect.poll(() => reads.beta).toBe(1)
    }
  }
  await expect(page.getByRole('heading', { name: 'Your next session starts here.' })).toBeVisible()
  await expect(page.getByRole('navigation').getByRole('button')).toHaveCount(0)
  await expect(page).toHaveURL(/\/$/)
  expect(writes).toEqual(['DELETE /api/targets/alpha', 'DELETE /api/targets/beta'])
})
