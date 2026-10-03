import { desktopAvailability } from './terminal-fixture'
import { codingIdentity } from './session-fixture'
import { expect, test, type Page, type Route } from '@playwright/test'
import type { Installation, SoftwareId, Target, Session, SessionBackend } from '../../shared/session-manager'
import { executionEnvironment, healthySoftware } from './software-fixture'

const target: Target = { id: 'software', name: 'Development', kind: 'ssh', host: 'dev', backends: ['dtach'], tools: ['codex', 'kimi'], createdAt: '2026-09-30T00:00:00Z' }
const script = '#!/bin/sh\n# Install the selected software\nset -eu\necho "installing"\n'
const completed: Installation = { id: 'job', softwareId: 'dtach', status: 'succeeded', startedAt: target.createdAt, finishedAt: target.createdAt, exitCode: 0, error: null }
async function fixture(page: Page, missing: SoftwareId[] = [], options: { backends?: SessionBackend[]; sessions?: Session[]; platform?: 'linux' | 'darwin'; installation?: Installation } = {}) {
  let checks = 0, installed = false, installCount = 0, submitted = ''
  let current = { ...target, backends: options.backends ?? target.backends }
  const sessions = options.sessions ?? []
  const created: Session[] = []
  let job: Installation | null = options.installation ?? null
  let failure = false, checkFailure = false, keepRunning = false
  const paths: string[] = []
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method()
    paths.push(path)
    if (path === '/api/targets') return route.fulfill({ json: [current] })
    if (path.endsWith('/software')) {
      checks++
      if (checkFailure) return route.fulfill({ status: 502, json: { message: 'SSH check unavailable' } })
      const report = healthySoftware(current.backends, current.tools, { ...executionEnvironment, platform: options.platform ?? 'linux' })
      report.installation = job
      if (!installed) report.software = report.software.map(item => missing.includes(item.id) ? { ...item, status: 'missing', path: null, version: null, detail: 'Not found on the interactive login PATH.' } : item)
      return route.fulfill({ json: report })
    }
    if (path.endsWith('/script')) return route.fulfill({ json: { softwareId: path.split('/').at(-2), script } })
    if (path.endsWith('/installations') && method === 'POST') {
      installCount++
      submitted = route.request().postDataJSON().script
      job = { ...completed, status: failure ? 'failed' : 'succeeded', exitCode: failure ? 7 : 0, error: failure ? 'Installation exited with status 7.' : null }
      if (keepRunning) job = { ...completed, status: 'running', finishedAt: null, exitCode: null }
      installed = !failure && !keepRunning
      return route.fulfill({ status: 202, json: { ...job, status: 'running' } })
    }
    if (path.endsWith('/installations')) return route.fulfill({ json: { installation: job } })
    if (path.endsWith('/events')) return route.fulfill({ contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'output', text: 'live output é\nerror detail\n' })}\n${JSON.stringify({ type: job?.status === 'running' ? 'status' : 'complete', installation: job })}\n` })
    if (path.endsWith('/requirements')) { current = { ...current, ...route.request().postDataJSON() }; return route.fulfill({ json: current }) }
    if (path.endsWith('/sessions') && method === 'POST') {
      const session: Session = { ...codingIdentity((route.request().postDataJSON()).tool, `new-${sessions.length}`), env: {}, args: '', ...route.request().postDataJSON(), id: `new-${sessions.length}`, createdAt: target.createdAt, lastConnectedAt: null, activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: 'idle', socketPath: '/root/.outpost/sockets/new.sock' }
      sessions.push(session)
      created.push(session)
      return route.fulfill({ status: 201, json: session })
    }
    if (path.endsWith('/sessions')) return route.fulfill({ json: { sessions, registryPath: '/root/.outpost/sessions.json' } })
    if (path.endsWith('/connect')) return route.fulfill({ json: { commands: { bash: 'curl session | bash' }, expiresAt: target.createdAt, desktop: desktopAvailability() } })
    if (path.endsWith('/directories')) return route.fulfill({ json: { directories: [], truncated: false } })
    return route.fulfill({ status: 404 })
  })
  await page.goto('/')
  return { checks: () => checks, installs: () => installCount, script: () => submitted, paths, created, target: () => current, keepRunning: () => { keepRunning = true }, finishInstall: () => { job = { ...completed }; installed = true }, failInstall: () => { failure = true }, failCheck: () => { checkFailure = true } }
}

test('all-good panel collapses, expands to show paths and versions, and refreshes live without stale success', async ({ page }) => {
  const state = await fixture(page)
  const panel = page.getByRole('region', { name: 'Required Software' })
  const toggle = panel.getByRole('button', { name: /Required Software/ })
  await expect(toggle).toContainText('All good')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(panel).toContainText('/usr/bin/dtach')
  await expect(panel).toContainText('codex 1.0')
  await expect(panel.getByRole('button', { name: /^Auto install/ })).toHaveCount(0)
  const before = state.checks()
  await page.reload()
  await expect.poll(state.checks).toBe(before + 1)
  state.failCheck()
  await page.getByRole('button', { name: 'Refresh required software' }).click()
  await expect(panel.getByRole('alert')).toContainText('SSH check unavailable')
  await expect(panel).not.toContainText('All good')
  expect(state.paths.some(path => path.endsWith('/setup'))).toBe(false)
  expect(state.installs()).toBe(0)
})

test('missing software opens a highlighted editable script, runs the edited text, streams logs, and refreshes on close', async ({ page }) => {
  const state = await fixture(page, ['dtach'])
  const panel = page.getByRole('region', { name: 'Required Software' })
  await expect(panel).toContainText('1 requirement needs attention')
  await expect(panel).toContainText('Not installed')
  await page.getByRole('button', { name: 'Auto install dtach', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Installation script' })
  await expect(editor).toContainText('set -eu')
  await expect.poll(() => page.locator('.cm-line span').count()).toBeGreaterThan(0)
  await page.screenshot({ path: 'test-results/install-script.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect(page.getByRole('button', { name: 'Run installation', exact: true })).toBeVisible()
  const edited = '#!/bin/sh\nprintf "custom installation é\\n"\n'
  await editor.fill(edited)
  await page.getByRole('button', { name: 'Run installation', exact: true }).click()
  await expect(page.getByLabel('Installation output')).toContainText('live output é')
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Script completed successfully')
  expect(state.script()).toBe(edited)
  expect(state.installs()).toBe(1)
  const before = state.checks()
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await expect.poll(state.checks).toBe(before + 1)
  await expect(panel).toContainText('All good')
  await expect(panel.getByRole('button', { name: /Required Software/ })).toHaveAttribute('aria-expanded', 'false')
})

test('canceling the preview still rechecks software and never executes a script', async ({ page }) => {
  const state = await fixture(page, ['dtach'])
  await page.getByRole('button', { name: 'Auto install dtach', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Installation script' })).toBeVisible()
  const before = state.checks()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect.poll(state.checks).toBe(before + 1)
  expect(state.installs()).toBe(0)
  await expect(page.getByRole('button', { name: 'Auto install dtach', exact: true })).toBeVisible()
})

test('failed installation preserves streamed output and the refreshed warning', async ({ page }) => {
  const state = await fixture(page, ['dtach'])
  state.failInstall()
  await page.getByRole('button', { name: 'Auto install dtach', exact: true }).click()
  await page.getByRole('button', { name: 'Run installation', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Installation failed')
  await expect(page.getByLabel('Installation output')).toContainText('error detail')
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Auto install dtach', exact: true })).toBeEnabled()
  await expect(page.getByRole('region', { name: 'Required Software' })).not.toContainText('All good')
})

test('required coding tools are configurable and new sessions offer only installed configured tools', async ({ page }) => {
  await fixture(page, ['codex'])
  await expect(page.getByRole('button', { name: 'New session' })).toBeEnabled()
  await page.getByRole('button', { name: 'New session' }).click()
  const choice = page.getByRole('combobox', { name: 'Coding tool' })
  await expect(choice).toHaveValue('kimi')
  await expect(choice.locator('option')).toHaveCount(1)
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await page.getByRole('button', { name: 'Configure required software' }).click()
  await page.getByRole('checkbox', { name: 'Codex', exact: true }).uncheck()
  await page.getByRole('button', { name: 'Save requirements', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Required Software' })).toContainText('All good')
})


test('both backends can be configured, changed live, and selected per session without hiding existing sessions', async ({ page }) => {
  const sessions: Session[] = (['tmux', 'dtach'] as const).map(backend => ({ ...codingIdentity('codex', backend),
    id: backend, backend, name: 'Shared name', tool: 'codex', rootDir: `/root/${backend}`,
    env: {}, args: '', createdAt: target.createdAt, lastConnectedAt: null,
    socketPath: `/root/.outpost/sockets/${backend}.sock`, activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: 'idle',
  }))
  const state = await fixture(page, [], { backends: ['tmux', 'dtach'], sessions })
  const panel = page.getByRole('region', { name: 'Required Software' })
  const toggle = panel.getByRole('button', { name: /Required Software/ })
  await expect(toggle).toContainText('All good')
  await expect(page.locator('.session-backend-badge')).toHaveText(['tmux', 'dtach'])
  await page.getByRole('button', { name: 'New session' }).click()
  const choice = page.getByRole('combobox', { name: 'Session backend', exact: true })
  await expect(choice.locator('option')).toHaveText(['tmux', 'dtach'])
  await choice.selectOption('dtach')
  await page.getByRole('textbox', { name: 'Session name' }).fill('New dtach work')
  await page.getByRole('combobox', { name: 'Root directory' }).fill('/root/project')
  await page.getByRole('dialog').getByRole('button', { name: 'Create session', exact: true }).click()
  await expect(page.locator('.session-backend-badge')).toHaveText(['tmux', 'dtach', 'dtach'])
  expect(state.created[0].backend).toBe('dtach')

  await toggle.click()
  await page.getByRole('button', { name: 'Configure required software', exact: true }).click()
  await page.getByRole('checkbox', { name: 'tmux', exact: true }).uncheck()
  await page.getByRole('checkbox', { name: 'dtach', exact: true }).uncheck()
  await expect(page.getByRole('button', { name: 'Save requirements', exact: true })).toBeDisabled()
  await page.getByRole('checkbox', { name: 'dtach', exact: true }).check()
  const before = state.checks()
  await page.getByRole('button', { name: 'Save requirements', exact: true }).click()
  await expect.poll(state.checks).toBe(before + 1)
  await expect(toggle).toContainText('All good')
  expect(state.target().backends).toEqual(['dtach'])
  await expect(page.locator('.target-backend')).toHaveText('Session backends: dtach')
  await expect(page.locator('.session-backend-badge')).toHaveText(['tmux', 'dtach', 'dtach'])
  await page.getByRole('button', { name: 'New session' }).click()
  await expect(choice.locator('option')).toHaveText(['dtach'])
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await page.locator('.session-row').filter({ has: page.locator('.session-backend-badge.tmux') }).getByRole('button', { name: /^Connection options for / }).click()
  await expect(page.getByRole('dialog')).toContainText('Session backend: tmux')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.reload()
  await expect(page.locator('.target-backend')).toHaveText('Session backends: dtach')
  await expect(page.locator('.session-backend-badge')).toHaveText(['tmux', 'dtach', 'dtach'])
})

for (const platform of ['linux', 'darwin'] as const) test(`${platform}: a missing backend dependency does not block healthy backends`, async ({ page }) => {
  const missing: SoftwareId[] = [platform === 'darwin' ? 'lsof' : 'dtach']
  await fixture(page, missing, { backends: ['tmux', 'dtach'], platform })
  await expect(page.getByRole('region', { name: 'Required Software' })).toContainText('1 requirement needs attention')
  await expect(page.getByRole('button', { name: `Auto install ${missing[0]}`, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New session' })).toBeEnabled()
  await page.getByRole('button', { name: 'New session' }).click()
  await expect(page.getByRole('combobox', { name: 'Session backend', exact: true }).locator('option')).toHaveText(['tmux'])
})

test('closing a running installation keeps its log available and refreshes once it finishes', async ({ page }) => {
  const state = await fixture(page, ['dtach'])
  state.keepRunning()
  await page.getByRole('button', { name: 'Auto install dtach', exact: true }).click()
  await page.getByRole('button', { name: 'Run installation', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Installing…')
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Auto install dtach', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'View installation log', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Installing…')
  await expect(page.getByLabel('Installation output')).toContainText('live output é')
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  state.finishInstall()
  await expect(page.getByRole('region', { name: 'Required Software' })).toContainText('All good')
  expect(state.installs()).toBe(1)
})

test('an open session form follows live software availability through a background installation recheck', async ({ page }) => {
  const running: Installation = { ...completed, status: 'running', finishedAt: null, exitCode: null }
  const state = await fixture(page, [], { backends: ['tmux', 'dtach'], installation: running })
  await expect(page.getByRole('button', { name: 'New session' })).toBeEnabled()
  let pending: Route | undefined
  let finished = false
  await page.route('**/api/targets/software/installations', route => route.fulfill({ json: { installation: finished ? completed : running } }))
  await page.route('**/api/targets/software/software', route => { pending = route })
  await page.getByRole('button', { name: 'New session' }).click()
  await page.getByRole('combobox', { name: 'Session backend', exact: true }).selectOption('dtach')
  await page.getByRole('combobox', { name: 'Coding tool', exact: true }).selectOption('kimi')
  await page.getByRole('textbox', { name: 'Session name' }).fill('Live choices')
  await page.getByRole('combobox', { name: 'Root directory' }).fill('/root/project')
  finished = true
  await expect.poll(() => !!pending).toBe(true)
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Create session', exact: true })).toBeDisabled()
  const refreshed = healthySoftware(['tmux', 'dtach'], ['codex', 'kimi'])
  refreshed.installation = completed
  refreshed.software = refreshed.software.map(item => item.id === 'dtach' || item.id === 'kimi'
    ? { ...item, status: 'missing', path: null, version: null, detail: 'Missing after the recheck' } : item)
  await pending!.fulfill({ json: refreshed })
  await expect(page.getByRole('combobox', { name: 'Session backend', exact: true })).toHaveValue('tmux')
  await expect(page.getByRole('combobox', { name: 'Coding tool', exact: true })).toHaveValue('codex')
  await page.getByRole('dialog').getByRole('button', { name: 'Create session', exact: true }).click()
  await expect(page.getByText('Live choices', { exact: true })).toBeVisible()
  expect(state.created[0]).toMatchObject({ backend: 'tmux', tool: 'codex' })
})
