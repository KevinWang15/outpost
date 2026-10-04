import { codingIdentity } from './session-fixture'
import type { CodingTool } from '../../shared/session-manager'
import { healthySoftware } from './software-fixture'
import { expect, test } from '@playwright/test'
import { desktopAvailability } from './terminal-fixture'
import { terminalApps, terminalOS } from '../../shared/terminals'

for (const platform of ['linux', 'darwin', 'win32']) test(`${platform}: add a local target, complete paths, fetch live lists, and launch`, async ({ page }) => {
  const usesWsl = platform === 'win32'
  await page.addInitScript(() => localStorage.setItem('outpost-terminal-apps', JSON.stringify({ windows: 'windows-terminal', macos: 'macos-terminal', linux: 'linux-xterm' })))
  const terminal = terminalApps.find(app => app.id === (usesWsl ? 'windows-terminal' : platform === 'darwin' ? 'macos-terminal' : 'linux-xterm'))!
  let target: Record<string, unknown> | undefined
  let session: Record<string, unknown> | undefined
  let reads = 0, launches = 0
  const commands = usesWsl ? { powershell: 'local-wsl-powershell', cmd: 'local-wsl-cmd' } : { bash: 'local-bash-command' }
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/auth/session') return route.fulfill({ json: { mode: 'local', user: null } })
    const path = new URL(route.request().url()).pathname
    const method = route.request().method()
    if (path === '/api/environment') return route.fulfill({ json: { platform, supported: true, usesWsl } })
    if (path === '/api/targets' && method === 'POST') {
      target = { ...route.request().postDataJSON(), id: 'local', createdAt: new Date().toISOString() }
      expect(target!.kind).toBe('local')
      expect(target!.host).toBeUndefined()
      expect(target!.identityFile).toBeUndefined()
      if (usesWsl) expect(target!.distribution).toBe('Ubuntu-24.04')
      return route.fulfill({ json: target })
    }
    if (path === '/api/targets') return route.fulfill({ json: target ? [target] : [] })
    if (path.endsWith('/software')) return route.fulfill({ json: { ...healthySoftware(['dtach'], target!.tools as CodingTool[]), environment: { home: '/home/dev', username: 'dev', uid: 1000, shell: '/bin/bash', platform: 'linux' } } })
    if (path.endsWith('/directories')) return route.fulfill({ json: { directories: ['~/projects/local/'], truncated: false } })
    if (path.endsWith('/sessions') && method === 'POST') {
      session = { ...codingIdentity((route.request().postDataJSON()).tool, 'session'), ...route.request().postDataJSON(), id: 'session', backend: 'dtach', activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: 'idle', lastConnectedAt: null, createdAt: new Date().toISOString() }
      return route.fulfill({ json: session })
    }
    if (path.endsWith('/sessions')) {
      reads++
      return route.fulfill({ json: { sessions: session ? [session] : [], registryPath: '/home/dev/.outpost/sessions.json' } })
    }
    if (path.endsWith('/connect')) return route.fulfill({ json: { commands, expiresAt: new Date(Date.now() + 900000).toISOString(), mode: 'local', desktop: desktopAvailability(terminalOS(platform)!, [terminal.id]) } })
    if (path.endsWith('/launch')) { expect(route.request().postDataJSON()).toEqual({ terminalId: terminal.id }); launches++; return route.fulfill({ json: terminal }) }
    return route.fulfill({ status: 404 })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Add your first target' }).click()
  const type = page.getByRole('combobox', { name: 'Connection type' })
  await expect(type.locator('option[value=local]')).toBeEnabled()
  await type.selectOption('local')
  await expect(page.getByRole('textbox', { name: 'Host or SSH alias' })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Identity file' })).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Target name' }).fill('My computer')
  if (usesWsl) await page.getByRole('textbox', { name: 'WSL distribution' }).fill('Ubuntu-24.04')
  await page.getByRole('checkbox', { name: 'tmux', exact: true }).uncheck()
  await page.getByRole('checkbox', { name: 'dtach', exact: true }).check()
  await page.getByRole('checkbox', { name: 'Kimi', exact: true }).check()
  await page.getByRole('dialog').getByRole('button', { name: 'Add target', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New session' })).toBeEnabled()
  await expect(page.locator('.target-address .tag')).toHaveText(usesWsl ? 'LOCAL / WSL' : 'LOCAL')
  await expect(page.locator('.target-backend')).toContainText('dtach')
  await page.getByRole('button', { name: 'New session' }).click()
  await page.getByRole('textbox', { name: 'Session name' }).fill('Local work')
  await page.getByRole('combobox', { name: 'Coding tool' }).selectOption('kimi')
  await page.getByRole('combobox', { name: 'Root directory' }).fill('~/projects/l')
  await page.getByRole('option', { name: '~/projects/local/' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Create session', exact: true }).click()
  await page.getByRole('button', { name: /^Connection options for / }).click()
  await page.getByRole('menuitem', { name: 'Connection options', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Terminal app' })).toHaveValue(terminal.id)
  await expect(page.getByRole('combobox', { name: 'Shell for copy command' })).toHaveValue(usesWsl ? 'powershell' : 'bash')
  await expect(page.getByRole('dialog')).toContainText('Choose a terminal on the computer running Outpost')
  await expect(page.getByRole('dialog')).not.toContainText('OpenSSH')
  const apps = page.getByRole('combobox', { name: 'Terminal app' })
  await apps.selectOption(usesWsl ? 'macos-iterm2' : 'windows-terminal')
  await expect(page.getByRole('dialog')).toContainText('This local session requires a terminal')
  await expect(page.getByRole('button', { name: 'Copy command' })).toHaveCount(0)
  await apps.selectOption(terminal.id)
  await page.getByRole('button', { name: 'Launch terminal' }).click()
  await expect.poll(() => launches).toBe(1)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  const before = reads
  await page.getByRole('navigation', { name: 'Targets' }).getByRole('button', { name: 'My computer', exact: true }).click()
  await expect.poll(() => reads).toBeGreaterThan(before)
  const after = reads
  await page.reload()
  await expect.poll(() => reads).toBeGreaterThan(after)
  await expect(page.locator('.session-identity')).toContainText('Local work')
  await page.screenshot({ path: `test-results/local-${platform}.png`, fullPage: true })
})
