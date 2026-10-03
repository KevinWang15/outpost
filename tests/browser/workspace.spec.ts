import { desktopAvailability } from './terminal-fixture'
import { codingIdentity } from './session-fixture'
import { healthySoftware } from './software-fixture'
import { expect, test } from '@playwright/test'
import { codingToolLabels, type Target, type Session } from '../../shared/session-manager'

for (const backend of ['tmux', 'dtach']) for (const [tool, toolLabel] of Object.entries(codingToolLabels)) test(`${backend} + ${tool}: target configuration, session creation, connection, filtering, and mobile layout`, async ({ page }) => {
  const configuredBackends = backend === 'tmux' && tool === 'codex' ? ['tmux', 'dtach'] : [backend]
  if (backend === 'tmux') await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }))
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const commands = { bash: "curl -fsS 'http://127.0.0.1:4178/api/connect/example' | bash", powershell: "& ([scriptblock]::Create((Invoke-RestMethod -Uri 'http://127.0.0.1:4178/api/connect/example')))", cmd: 'powershell.exe -NoLogo -NoProfile -Command "example"' }
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  let targets: Target[] = []
  const sessions: Session[] = []
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/auth/session') return route.fulfill({ json: { mode: 'local', user: null } })
    const path = new URL(route.request().url()).pathname
    const method = route.request().method()
    let result: unknown
    if (path === '/api/environment') return route.fulfill({ json: { platform: 'linux', supported: true, usesWsl: false } })
    if (path === '/api/targets' && method === 'GET') result = targets
    else if (path === '/api/targets' && method === 'POST') {
      const input = route.request().postDataJSON()
      const target: Target = { ...input, id: 'target-1', createdAt: new Date().toISOString() }
      targets = [target]; result = target
    } else if (path.endsWith('/software')) result = healthySoftware(targets[0].backends, targets[0].tools)
    else if (path.endsWith('/sessions') && method === 'GET') result = { sessions, registryPath: '/root/.outpost/sessions.json' }
    else if (path.endsWith('/sessions') && method === 'POST') {
      const session: Session = { ...codingIdentity((route.request().postDataJSON()).tool, '55eef465-9d0f-4992-8f1a-859dc977f7f5'), ...route.request().postDataJSON(), id: '55eef465-9d0f-4992-8f1a-859dc977f7f5', createdAt: new Date().toISOString(), lastConnectedAt: null, activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: 'idle', socketPath: '/root/.outpost/sockets/55eef465.sock' }
      sessions.push(session); result = session
    } else if (path.endsWith('/connect')) result = { commands, expiresAt: new Date(Date.now() + 900000).toISOString(), desktop: desktopAvailability() }
    else return route.fulfill({ status: 404, json: { message: 'Not found' } })
    await route.fulfill({ json: result })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Your next session starts here.' })).toBeVisible()
  await page.screenshot({ path: 'test-results/welcome.png', fullPage: true })
  await page.getByRole('button', { name: 'Add your first target' }).click()
  await page.getByRole('textbox', { name: 'Target name' }).fill('Development')
  await page.getByRole('textbox', { name: 'Host or SSH alias' }).fill('dev.example.com')
  await expect(page.getByRole('checkbox', { name: 'tmux', exact: true })).toBeChecked()
  if (backend === 'dtach') {
    await page.getByRole('checkbox', { name: 'tmux', exact: true }).uncheck()
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Add target', exact: true })).toBeDisabled()
    await page.getByRole('checkbox', { name: 'dtach', exact: true }).check()
  }
  if (configuredBackends.length === 2) await page.getByRole('checkbox', { name: 'dtach', exact: true }).check()
  await page.screenshot({ path: `test-results/add-target-${backend}.png`, fullPage: true })
  await expect(page.getByRole('dialog').locator('.form-note')).toContainText('Adding an instance saves its settings')
  await page.getByRole('checkbox', { name: 'Kimi', exact: true }).check()
  await page.getByRole('checkbox', { name: 'Claude', exact: true }).check()
  await page.getByRole('dialog').getByRole('button', { name: 'Add target', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New session' })).toBeEnabled()
  expect(targets[0].backends).toEqual(configuredBackends)
  await page.getByRole('button', { name: 'New session' }).click()
  await expect(page.getByRole('combobox', { name: 'Session backend', exact: true }).locator('option')).toHaveText(configuredBackends)
  await page.getByRole('combobox', { name: 'Session backend', exact: true }).selectOption(backend)
  await expect(page.getByRole('dialog')).toContainText(`Uses ${backend}`)
  const toolChoice = page.getByRole('combobox', { name: 'Coding tool' })
  await expect(toolChoice).toHaveValue('codex')
  await toolChoice.selectOption(tool)
  await expect(page.getByRole('dialog').locator('.form-note')).toContainText(`${toolLabel} starts when you connect`)
  await expect(page.getByRole('dialog').locator('.form-note')).toContainText('resumes the same conversation after a restart')
  await page.getByRole('textbox', { name: 'Session name' }).fill('Session manager')
  await page.getByRole('combobox', { name: 'Root directory' }).fill('/root/projects/outpost')
  await page.getByText('Arguments and environment variables (optional)', { exact: true }).click()
  const args = '--label "two words" --message "$MESSAGE"'
  const message = "literal 'quotes' $HOME $(echo not-executed)\nsecond é"
  await page.getByRole('textbox', { name: 'Arguments', exact: true }).fill(args)
  for (const [index, name, value] of [[1, 'MESSAGE', message], [2, 'REMOVE_ME', 'discard'], [3, 'EMPTY', '']] as const) {
    await page.getByRole('button', { name: 'Add variable', exact: true }).click()
    await page.getByRole('textbox', { name: `Environment variable name ${index}`, exact: true }).fill(name)
    await page.getByRole('textbox', { name: `Environment variable value ${index}`, exact: true }).fill(value)
  }
  await page.getByRole('button', { name: 'Remove environment variable 2', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Environment variable name 2', exact: true })).toHaveValue('EMPTY')
  if (backend === 'tmux' && tool === 'codex') {
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => page.getByRole('dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true)
    await page.screenshot({ path: 'test-results/session-options-mobile.png', fullPage: true })
    await page.setViewportSize({ width: 1440, height: 1000 })
  }
  await page.getByRole('dialog').getByRole('button', { name: 'Create session', exact: true }).click()
  await expect(page.getByText('Not connected yet')).toBeVisible()
  expect(sessions[0].tool).toBe(tool)
  expect(sessions[0].backend).toBe(backend)
  expect(sessions[0].args).toBe(args)
  expect(sessions[0].env).toEqual({ MESSAGE: message, EMPTY: '' })
  await expect(page.locator('.session-backend-badge')).toHaveText(backend)
  await expect(page.locator('.session-identity small')).toContainText(toolLabel)
  await page.reload()
  await expect(page.locator('.target-backend')).toContainText(`Session backends: ${configuredBackends.join(' + ')}`)
  await expect(page.locator('.session-backend-badge')).toHaveText(backend)
  await expect(page.locator('.session-identity small')).toContainText(toolLabel)
  await page.getByRole('button', { name: /^Connection options for / }).click()
  await page.getByRole('menuitem', { name: 'Connection options', exact: true }).click()
  const terminal = page.getByRole('combobox', { name: 'Shell for copy command' })
  await expect(terminal).toHaveValue(backend === 'tmux' ? 'powershell' : 'bash')
  await page.getByRole('combobox', { name: 'Terminal app' }).selectOption('windows-terminal')
  await expect(page.getByRole('dialog')).toContainText('Selecting an app saves your preference for Windows.')
  for (const shell of ['bash', 'cmd', 'powershell'] as const) {
    await terminal.selectOption(shell)
    await expect(page.locator('.command-box code')).toHaveText(commands[shell])
    await page.getByRole('button', { name: 'Copy command', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(commands[shell])
  }
  await expect(page.getByRole('dialog')).toContainText(`${toolLabel} keeps running`)
  await expect(page.getByRole('dialog')).toContainText(`Coding tool: ${toolLabel}`)
  await page.screenshot({ path: 'test-results/connect.png', fullPage: true })
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: /^Connection options for / }).click()
  await page.getByRole('menuitem', { name: 'Connection options', exact: true }).click()
  // This browser's native OS remains the default; favorites are saved per OS.
  await page.getByRole('combobox', { name: 'Terminal app' }).selectOption('windows-terminal')
  await expect(terminal).toHaveValue('powershell')
  await expect(page.locator('.command-box code')).toHaveText(commands.powershell)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('textbox', { name: 'Search sessions' }).fill('nothing-matches')
  await expect(page.getByText('No sessions match')).toBeVisible()
  await page.getByRole('textbox', { name: 'Search sessions' }).fill('')
  await page.screenshot({ path: 'test-results/workspace.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true })
  expect(errors).toEqual([])
})

test('software check failures remain visible and can be retried', async ({ page }) => {
  let attempts = 0
  const target = { backends: ['dtach'], tools: ['codex'], id: 'retry', name: 'Retry server', kind: 'ssh', host: 'dev-alias', createdAt: new Date().toISOString() }
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/auth/session') return route.fulfill({ json: { mode: 'local', user: null } })
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/software')) {
      if (++attempts === 1) return route.fulfill({ status: 502, json: { message: 'SSH authentication failed. Load your key into ssh-agent.' } })
      return route.fulfill({ json: healthySoftware(['dtach'], ['codex']) })
    }
    if (path.endsWith('/sessions')) return route.fulfill({ json: { sessions: [], registryPath: '/root/.outpost/sessions.json' } })
    return route.fulfill({ json: [target] })
  })
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('SSH authentication failed')
  await expect(page.getByRole('button', { name: 'New session' })).toBeDisabled()
  await page.getByRole('button', { name: 'Refresh required software' }).click()
  await expect(page.getByRole('button', { name: 'New session' })).toBeEnabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
})
