import { desktopAvailability } from './terminal-fixture'
import { terminalApps, type DesktopTerminal, type DesktopLaunchInput } from '../../shared/terminals'
import { codingIdentity } from './session-fixture'
import { healthySoftware } from './software-fixture'
import { expect, test, type Page, type Route } from '@playwright/test'

const windowsTerminal = terminalApps.find(app => app.id === 'windows-terminal')!
const gnomeTerminal = terminalApps.find(app => app.id === 'linux-gnome')!

async function workspace(page: Page, terminal: DesktopTerminal | null, launch: (route: Route) => Promise<void> = async route => {
  await route.fulfill(terminal ? { json: terminal } : { status: 409, json: { message: 'No desktop terminal is available on the computer running the manager. Use Copy command instead.' } })
}) {
  const requests: string[] = []
  const connections: string[] = []
  const inputs: DesktopLaunchInput[] = []
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/auth/session') return route.fulfill({ json: { mode: 'local', user: null } })
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware([path.includes('beta') || path.includes('dtach') ? 'dtach' : 'tmux']) })
    if (path.endsWith('/launch')) {
      expect(route.request().method()).toBe('POST')
      expect(route.request().headers()['x-outpost-request']).toBe('1')
      inputs.push(route.request().postDataJSON())
      requests.push(path)
      return launch(route)
    }
    if (path === '/api/targets') return route.fulfill({ json: [{ id: 'desktop-target', name: 'Dev', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev', backends: ['tmux'], createdAt: '2026-09-29T00:00:00Z', environment: { home: '/root', platform: 'linux', username: 'root', uid: 0, shell: '/bin/bash',  } }] })
    if (path.endsWith('/sessions')) return route.fulfill({ json: { sessions: [{ ...codingIdentity('kimi', 'session'), id: 'session', name: 'Desktop session', backend: 'tmux', tool: 'kimi', rootDir: '/root/projects/app', activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: 'idle', lastConnectedAt: null }], registryPath: '/root/.outpost/sessions.json' } })
    if (path.endsWith('/connect')) {
      connections.push(path)
      return route.fulfill({ json: { commands: { bash: 'bash-command', powershell: 'powershell-command', cmd: 'cmd-command' }, expiresAt: new Date(Date.now() + 900000).toISOString(), mode: 'local', desktop: desktopAvailability(terminal?.os ?? 'linux', terminal ? [terminal.id] : []) } })
    }
    return route.fulfill({ status: 404 })
  })
  await page.goto('/')
  await expect(page.getByText('Desktop session', { exact: true })).toBeVisible()
  return { requests, connections, inputs }
}

async function openOptions(page: Page) {
  await page.getByRole('button', { name: 'Connection options for Desktop session', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Connection options', exact: true }).click()
}

test('Connect directly launches once without preparing commands or opening a modal', async ({ page }) => {
  let pending: Route | undefined
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { value: 'Windows NT 10.0' }))
  const { requests, connections } = await workspace(page, windowsTerminal, async route => { pending = route })
  const connect = page.getByRole('button', { name: 'Connect', exact: true })
  const options = page.getByRole('button', { name: 'Connection options for Desktop session', exact: true })
  const left = (await connect.boundingBox())!
  const right = (await options.boundingBox())!
  expect(left.x + left.width).toBeCloseTo(right.x)
  expect(left.y).toBe(right.y)
  expect(left.height).toBe(right.height)
  await connect.click()
  await expect(page.getByRole('button', { name: 'Opening…', exact: true })).toBeDisabled()
  await expect(options).toBeDisabled()
  await expect.poll(() => requests.length).toBe(1)
  await page.locator('.connect-button > button').first().evaluate(button => (button as HTMLButtonElement).click())
  expect(requests).toHaveLength(1)
  expect(connections).toEqual([])
  await pending!.fulfill({ json: windowsTerminal })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.toast')).toContainText('Opening Desktop session in Windows Terminal on the manager computer.')
  await expect(connect).toBeEnabled()
  await expect(options).toBeEnabled()
  expect(connections).toEqual([])
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(connect).toBeVisible()
  await expect(options).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/direct-connect-mobile.png', fullPage: true })
  await page.getByRole('button', { name: 'Dismiss notification' }).click()
  await expect(page.locator('.toast')).toHaveCount(0)
})

test('ellipsis opens options with the keyboard, puts terminal selection and launch before manual copy, and avoids duplicate pending requests', async ({ page }) => {
  let pending: Route | undefined
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { value: 'Windows NT 10.0' }))
  const { requests, connections, inputs } = await workspace(page, windowsTerminal, async route => { pending = route })
  const options = page.getByRole('button', { name: 'Connection options for Desktop session', exact: true })
  await options.focus()
  await options.press('Enter')
  await page.getByRole('menuitem', { name: 'Connection options', exact: true }).press('Enter')
  const dialog = page.getByRole('dialog')
  const launch = dialog.getByRole('button', { name: 'Launch terminal', exact: true })
  await expect(launch).toBeVisible()
  await expect(dialog).toContainText('Opens Windows Terminal with PowerShell on the computer running Outpost.')
  const copied = (await dialog.getByRole('button', { name: 'Copy command' }).boundingBox())!
  expect((await launch.boundingBox())!.y).toBeLessThan(copied.y)
  expect(requests).toEqual([])
  expect(connections).toHaveLength(1)
  await launch.click()
  await expect(dialog.getByRole('button', { name: 'Launching…' })).toBeDisabled()
  await expect.poll(() => requests.length).toBe(1)
  expect(inputs).toEqual([{ terminalId: 'windows-terminal' }])
  await expect(dialog.getByRole('combobox', { name: 'Terminal app' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Launching…' }).evaluate(button => (button as HTMLButtonElement).click())
  expect(inputs).toHaveLength(1)
  await pending!.fulfill({ json: windowsTerminal })
  await expect(dialog.getByRole('status')).toContainText('Launch requested in Windows Terminal')
  await expect(launch).toBeEnabled()
  expect(requests).toEqual(['/api/targets/desktop-target/sessions/session/launch'])
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(launch).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/desktop-launch-mobile.png', fullPage: true })
})

test('launch errors are retryable and leave copy and shell selection usable', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  let attempts = 0
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { value: 'Windows NT 10.0' }))
  await workspace(page, windowsTerminal, async route => {
    await route.fulfill(++attempts === 1
      ? { status: 502, json: { message: 'Could not launch Windows Terminal. Use Copy command instead.' } }
      : { json: windowsTerminal })
  })
  await openOptions(page)
  const launch = page.getByRole('button', { name: 'Launch terminal', exact: true })
  await launch.click()
  await expect(page.getByRole('alert')).toContainText('Could not launch Windows Terminal')
  await page.getByRole('combobox', { name: 'Shell for copy command' }).selectOption('cmd')
  await page.getByRole('button', { name: 'Copy command' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('cmd-command')
  await launch.click()
  await expect(page.getByRole('status')).toContainText('Launch requested in Windows Terminal')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('headless managers offer copy commands without a desktop launch button', async ({ page }) => {
  const { requests } = await workspace(page, null)
  await openOptions(page)
  await expect(page.getByRole('button', { name: 'Copy command' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Launch terminal' })).toHaveCount(0)
  await expect(page.getByRole('dialog')).toContainText('No desktop terminal was detected on the computer running Outpost.')
  expect(requests).toEqual([])
})

test('a headless direct launch falls back to usable options with a visible, dismissible toast above the modal', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const { requests, connections } = await workspace(page, null)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connect to Desktop session' })
  await expect(dialog).toBeVisible()
  const toast = page.locator('.toast')
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('No desktop terminal is available')
  expect(requests).toHaveLength(1)
  expect(connections).toHaveLength(1)
  await expect(dialog.getByRole('button', { name: 'Launch terminal' })).toHaveCount(0)
  await dialog.getByRole('combobox', { name: 'Terminal app' }).selectOption('windows-terminal')
  await dialog.getByRole('combobox', { name: 'Shell for copy command' }).selectOption('cmd')
  await dialog.getByRole('button', { name: 'Copy command' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('cmd-command')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await toast.evaluate(element => {
    const box = element.getBoundingClientRect()
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
  })).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/direct-connect-fallback-mobile.png' })
  await toast.getByRole('button', { name: 'Dismiss notification' }).click()
  await expect(toast).toHaveCount(0)
  await expect(dialog).toBeVisible()
})

test('a terminal startup failure opens options automatically and still permits a manual retry', async ({ page }) => {
  let attempts = 0
  await workspace(page, gnomeTerminal, async route => {
    await route.fulfill(++attempts === 1
      ? { status: 502, json: { message: 'Display access denied' } }
      : { json: gnomeTerminal })
  })
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(page.locator('.toast')).toContainText('Display access denied')
  await page.getByRole('button', { name: 'Dismiss notification' }).click()
  await dialog.getByRole('button', { name: 'Launch terminal', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('Launch requested in GNOME Terminal')
  expect(attempts).toBe(2)
})

for (const [os, userAgent, terminal] of [
  ['macOS', 'Macintosh; Intel Mac OS X', terminalApps.find(app => app.id === 'macos-iterm2')!],
  ['Windows', 'Windows NT 10.0', windowsTerminal],
  ['Linux', 'X11; Linux x86_64', gnomeTerminal],
] as const) test(`${os}: OS groups and recommendations come first while every supported terminal remains visible`, async ({ page }) => {
  await page.addInitScript(agent => Object.defineProperty(navigator, 'userAgent', { value: agent }), userAgent)
  await workspace(page, terminal)
  await openOptions(page)
  const apps = page.getByRole('combobox', { name: 'Terminal app' })
  await expect(apps).toHaveValue(terminal.id)
  const groups = await apps.locator('optgroup').evaluateAll(groups => groups.map(group => ({ label: group.getAttribute('label'), ids: [...group.querySelectorAll('option')].map(option => option.value) })))
  expect(groups[0].label).toContain(os)
  expect(groups[0].label).toContain('Your OS')
  expect(groups[0].label).toContain('Outpost computer')
  expect(groups).toHaveLength(3)
  expect(groups.find(group => group.label!.startsWith('macOS'))!.ids.slice(0, 2)).toEqual(['macos-iterm2', 'macos-terminal'])
  expect(groups.find(group => group.label!.startsWith('Windows'))!.ids.slice(0, 2)).toEqual(['windows-terminal', 'windows-console'])
  expect(groups.flatMap(group => group.ids)).toHaveLength(17)
  await expect(apps.locator(`option[value=${terminal.id}]`)).toContainText('Recommended')
  await expect(apps.locator(`option[value=${terminal.id}]`)).toContainText('Available')
  await page.screenshot({ path: `test-results/terminal-picker-${os}.png` })
})

test('a Mac browser connected to a Linux manager can copy for iTerm2 or explicitly launch on the manager', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { value: 'Macintosh; Intel Mac OS X' }))
  const { inputs } = await workspace(page, gnomeTerminal)
  await openOptions(page)
  const dialog = page.getByRole('dialog')
  const apps = dialog.getByRole('combobox', { name: 'Terminal app' })
  await expect(apps).toHaveValue('macos-iterm2')
  expect(await apps.locator('optgroup').evaluateAll(groups => groups.map(group => group.getAttribute('label')!.split(' · ')[0]))).toEqual(['macOS', 'Linux', 'Windows'])
  await expect(dialog).toContainText('Outpost is running on Linux. To use iTerm2 on your computer, copy the command below.')
  await expect(dialog.getByRole('button', { name: 'Launch terminal' })).toHaveCount(0)
  await expect(dialog.locator('.command-box code')).toHaveText('bash-command')
  await apps.selectOption('linux-gnome')
  await dialog.getByRole('button', { name: 'Launch terminal' }).click()
  await expect(dialog.getByRole('status')).toContainText('GNOME Terminal on the computer running Outpost')
  expect(inputs).toEqual([{ terminalId: 'linux-gnome' }])
})

test('terminal favorites persist independently per OS and direct Connect sends them for host-side detection', async ({ page }) => {
  const { inputs, connections } = await workspace(page, gnomeTerminal)
  await openOptions(page)
  const apps = page.getByRole('combobox', { name: 'Terminal app' })
  await apps.selectOption('macos-terminal')
  await apps.selectOption('windows-alacritty')
  await apps.selectOption('linux-xterm')
  await expect(page.getByRole('dialog')).toContainText('XTerm is unavailable')
  await expect(page.getByRole('button', { name: 'Launch terminal' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.reload()
  await openOptions(page)
  await expect(apps).toHaveValue('linux-xterm')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.locator('.toast')).toContainText('GNOME Terminal')
  expect(inputs).toEqual([{ preferences: { macos: 'macos-terminal', windows: 'windows-alacritty', linux: 'linux-xterm' } }])
  expect(connections, 'direct launch does not prepare unused copy commands').toHaveLength(2)
})

for (const storage of ['malformed', 'wrong OS', 'disabled'] as const) test(`terminal preferences recover when storage is ${storage}`, async ({ page }) => {
  await page.addInitScript(mode => {
    if (mode === 'disabled') {
      const get = Storage.prototype.getItem, set = Storage.prototype.setItem
      Storage.prototype.getItem = function(key) { if (key === 'outpost-terminal-apps') throw new Error('Storage denied'); return get.call(this, key) }
      Storage.prototype.setItem = function(key, value) { if (key === 'outpost-terminal-apps') throw new Error('Storage denied'); return set.call(this, key, value) }
    } else localStorage.setItem('outpost-terminal-apps', mode === 'malformed' ? '{' : JSON.stringify({ linux: 'macos-iterm2', macos: '/bin/sh' }))
  }, storage)
  await workspace(page, gnomeTerminal)
  await openOptions(page)
  const apps = page.getByRole('combobox', { name: 'Terminal app' })
  await expect(apps).toHaveValue('linux-gnome')
  await apps.selectOption('linux-xterm')
  await expect(page.locator('.command-box code')).toHaveText('bash-command')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.locator('.toast')).toContainText('GNOME Terminal')
})

test('a launch network failure also opens connection options', async ({ page }) => {
  const { connections } = await workspace(page, gnomeTerminal, async route => { await route.abort('failed') })
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('.toast')).toContainText('Could not open a terminal')
  expect(connections).toHaveLength(1)
})

test('failed fallback preparation reports the error and allows a fresh direct attempt', async ({ page }) => {
  let attempts = 0
  await workspace(page, gnomeTerminal, async route => {
    await route.fulfill(++attempts === 1
      ? { status: 502, json: { message: 'Terminal unavailable' } }
      : { json: gnomeTerminal })
  })
  await page.route('**/sessions/session/connect', async route => { await route.fulfill({ status: 502, json: { message: 'Could not load connection commands' } }) })
  const connect = page.getByRole('button', { name: 'Connect', exact: true })
  await connect.click()
  await expect(page.getByRole('alert')).toContainText('Could not load connection commands')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(connect).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Connection options for Desktop session' })).toBeEnabled()
  await connect.click()
  await expect(page.locator('.toast')).toContainText('Opening Desktop session')
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(attempts).toBe(2)
})
