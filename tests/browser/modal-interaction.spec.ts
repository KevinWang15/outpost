import { desktopAvailability } from './terminal-fixture'
import { codingIdentity } from './session-fixture'
import { expect, test, type Page } from '@playwright/test'
import { healthySoftware } from './software-fixture'

async function workspace(page: Page) {
  const writes: string[] = []
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/environment') return route.fulfill({ json: { platform: 'linux', supported: true, usesWsl: false } })
    if (path === '/api/targets') {
      if (route.request().method() !== 'GET') writes.push(path)
      return route.fulfill({ json: [{ id: 'forms', kind: 'ssh', name: 'Development', host: 'dev.example.com', backends: ['tmux'], tools: ['codex', 'kimi', 'claude'], createdAt: '2026-09-30T00:00:00Z' }] })
    }
    if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware() })
    if (path.endsWith('/sessions')) return route.fulfill({ json: { sessions: [{ ...codingIdentity('codex', 'work'), id: 'work', name: 'Work', backend: 'tmux', tool: 'codex', rootDir: '/home/dev/project', activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: 'detached', lastConnectedAt: null }], registryPath: '/home/dev/.outpost/sessions.json' } })
    if (path.endsWith('/directories')) return route.fulfill({ json: { directories: ['/home/dev/project/'], truncated: false } })
    if (path.endsWith('/connect')) return route.fulfill({ json: { commands: { bash: 'bash-command', powershell: 'powershell-command', cmd: 'cmd-command' }, expiresAt: '2026-09-30T23:59:59Z', desktop: desktopAvailability() } })
    throw new Error(`Unexpected request: ${path}`)
  })
  await page.goto('/')
  await expect(page.getByText('Work', { exact: true })).toBeVisible()
  return writes
}

test('the session modal is wide on desktop, groups choices together, and keeps all actions reachable on a short mobile screen', async ({ page }) => {
  await workspace(page)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Create a session' })
  await page.getByRole('textbox', { name: 'Session name' }).fill('Wide draft')
  await page.getByRole('combobox', { name: 'Root directory' }).fill('/home/dev/project')
  await dialog.getByRole('heading', { name: 'Create a session' }).click()
  const box = (await dialog.boundingBox())!
  expect(box.width).toBeGreaterThanOrEqual(760)
  expect(box.height).toBeLessThan(760)
  const backend = (await page.getByRole('combobox', { name: 'Session backend' }).boundingBox())!
  const tool = (await page.getByRole('combobox', { name: 'Coding tool' }).boundingBox())!
  expect(backend.y).toBeCloseTo(tool.y)
  expect(tool.x).toBeGreaterThan(backend.x + backend.width)
  expect((await page.getByRole('combobox', { name: 'Root directory' }).boundingBox())!.width).toBeGreaterThan(650)
  await page.screenshot({ path: 'test-results/session-modal-wide.png' })
  await page.setViewportSize({ width: 390, height: 600 })
  const mobile = (await dialog.boundingBox())!
  expect(mobile.width).toBeLessThanOrEqual(358)
  expect(mobile.y).toBeGreaterThanOrEqual(0)
  expect(mobile.y + mobile.height).toBeLessThanOrEqual(600)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await dialog.getByRole('button', { name: 'Create session', exact: true }).scrollIntoViewIfNeeded()
  await expect(dialog.getByRole('button', { name: 'Create session', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/session-modal-short-mobile.png' })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
})

test('target drafts survive padding clicks, backdrop clicks, and Escape until explicitly closed', async ({ page }) => {
  const writes = await workspace(page)
  await page.locator('.add-target').click()
  const dialog = page.getByRole('dialog', { name: 'Add a target' })
  const name = page.getByRole('textbox', { name: 'Target name' })
  const host = page.getByRole('textbox', { name: 'Host or SSH alias' })
  await name.fill('Unsubmitted target')
  await host.fill('dev.example.com')
  await dialog.getByRole('checkbox', { name: 'dtach', exact: true }).check()
  await dialog.getByRole('checkbox', { name: 'Claude', exact: true }).check()
  const box = (await dialog.boundingBox())!
  await page.mouse.click(box.x + 8, box.y + 80)
  await expect(dialog).toBeVisible()
  await page.mouse.click(8, 8)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(name).toHaveValue('Unsubmitted target')
  await expect(host).toHaveValue('dev.example.com')
  await expect(dialog.getByRole('checkbox', { name: 'dtach', exact: true })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: 'Claude', exact: true })).toBeChecked()
  expect(writes).toEqual([])
  await page.screenshot({ path: 'test-results/target-modal-wide.png' })
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(writes).toEqual([])
})

test('connection options also require an explicit close and retain the chosen shell after backdrop clicks and Escape', async ({ page }) => {
  await workspace(page)
  await page.getByRole('button', { name: 'Connection options for Work', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connect to Work' })
  await dialog.getByRole('combobox', { name: 'Terminal app' }).selectOption('windows-terminal')
  const shell = dialog.getByRole('combobox', { name: 'Shell for copy command' })
  await shell.selectOption('cmd')
  await page.mouse.click(8, 8)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(shell).toHaveValue('cmd')
  await expect(dialog.locator('.command-box code')).toHaveText('cmd-command')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(dialog).toHaveCount(0)
})
