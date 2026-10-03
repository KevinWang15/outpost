import { desktopAvailability } from './terminal-fixture'
import { codingIdentity } from './session-fixture'
import { expect, test, type Page } from '@playwright/test'
import { healthySoftware } from './software-fixture'

async function connect(page: Page) {
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/auth/session') return route.fulfill({ json: { mode: 'local', user: null } })
    const path = new URL(route.request().url()).pathname
    if (path === '/api/environment') return route.fulfill({ json: { platform: 'linux', supported: true, usesWsl: false } })
    if (path === '/api/targets') return route.fulfill({ json: [{ id: 'keys', kind: 'ssh', name: 'Keys', host: 'dev.example.com', backends: ['tmux'], tools: ['codex'], createdAt: '2026-09-30T00:00:00Z' }] })
    if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware(['tmux'], ['codex']) })
    if (path.endsWith('/sessions')) return route.fulfill({ json: { sessions: [{ ...codingIdentity('codex', 'work'), id: 'work', name: 'Work', backend: 'tmux', tool: 'codex', rootDir: '/home/dev/project', activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: 'detached', lastConnectedAt: null }], registryPath: '/home/dev/.outpost/sessions.json' } })
    if (path.endsWith('/connect')) return route.fulfill({ json: { commands: { bash: 'bash-command', powershell: 'powershell-command', cmd: 'cmd-command' }, expiresAt: '2026-09-30T23:59:59Z', desktop: desktopAvailability() } })
    throw new Error(`Unexpected request: ${path}`)
  })
  await page.goto('/')
  await page.getByRole('button', { name: /^Connection options for / }).click()
  await page.getByRole('menuitem', { name: 'Connection options', exact: true }).click()
}

test.describe('Windows Terminal keyboard help', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36' })

  test('the copied keybinding is valid JSON and sends an actual Shift+Enter escape without replacing existing actions', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await connect(page)
    await page.getByText('Newline with Shift+Enter', { exact: true }).click()
    const help = page.locator('.keyboard-help')
    await expect(help).toContainText('existing actions array')
    await expect(help).toContainText('keeping your other entries')
    await help.getByRole('button', { name: 'Copy keybinding' }).click()
    await expect(help.getByRole('button', { name: 'Binding copied' })).toBeVisible()
    const text = await page.evaluate(() => navigator.clipboard.readText())
    expect(text).toContain('\\u001b[13;2u')
    expect(JSON.parse(text)).toEqual({ keys: 'shift+enter', command: { action: 'sendInput', input: '\u001b[13;2u' } })
    await page.getByRole('button', { name: 'Copy command', exact: true }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('powershell-command')
    await page.setViewportSize({ width: 390, height: 600 })
    await help.getByRole('button', { name: 'Binding copied' }).scrollIntoViewIfNeeded()
    const dialog = await page.getByRole('dialog').boundingBox()
    expect(dialog!.y).toBeGreaterThanOrEqual(0)
    expect(dialog!.y + dialog!.height).toBeLessThanOrEqual(600)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: 'test-results/keyboard-help-windows-mobile.png' })
  })

  test('copy failures retain the selectable keybinding and can be retried without affecting connection controls', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.addInitScript(() => {
      const write = navigator.clipboard.writeText.bind(navigator.clipboard)
      let calls = 0
      navigator.clipboard.writeText = text => ++calls === 1 ? Promise.reject(new Error('Clipboard denied')) : write(text)
    })
    await connect(page)
    await page.getByText('Newline with Shift+Enter', { exact: true }).click()
    const help = page.locator('.keyboard-help')
    await help.getByRole('button', { name: 'Copy keybinding' }).click()
    await expect(page.getByRole('alert')).toContainText('copy the keybinding above')
    await expect(help.locator('.binding-box code')).toBeVisible()
    await page.getByRole('combobox', { name: 'Shell for copy command' }).selectOption('cmd')
    await help.getByRole('button', { name: 'Copy keybinding' }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(help.getByRole('button', { name: 'Binding copied' })).toBeVisible()
  })
})

test('other platforms show terminal requirements and keep connection commands usable in the expanded help', async ({ page }) => {
  await connect(page)
  await page.getByText('Newline with Shift+Enter', { exact: true }).click()
  await expect(page.locator('.keyboard-help')).toContainText('terminal that sends extended keys')
  await expect(page.getByRole('button', { name: 'Copy keybinding' })).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Terminal app' }).selectOption('windows-console')
  await page.getByRole('combobox', { name: 'Shell for copy command' }).selectOption('cmd')
  await expect(page.locator('.command-box code')).toHaveText('cmd-command')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
