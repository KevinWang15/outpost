import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url))
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 9)])

async function addTarget(page: Page, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add target' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Add a target' })
  await dialog.getByRole('radio', { name: 'This computer' }).click()
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByText('Codex').click()
  await dialog.getByRole('button', { name: 'Add target' }).click()
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Required software' })).toContainText('Ready')
}

async function createSession(page: Page, name: string, directory: string) {
  await page.getByRole('button', { name: 'New session' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New session' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('combobox').fill(directory)
  await dialog.getByText('Create the directory if it doesn’t exist').click()
  await dialog.getByRole('button', { name: 'Create session' }).click()
  await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible()
}

test('add a target, create a session, and work in the web terminal', async ({ page }) => {
  await addTarget(page, 'Browser box')
  await createSession(page, 'Browser session', '~/browser-project')
  const row = page.getByRole('row').filter({ hasText: 'Browser session' })
  await expect(row).toContainText('Not started')

  await row.getByRole('button', { name: 'Connect' }).click()
  const connect = page.getByRole('dialog', { name: 'Connect to Browser session' })
  await expect(connect.getByText('Desktop terminals · requires connector')).toBeVisible()
  await expect(connect.getByRole('button', { name: /iTerm2/ })).toBeVisible()
  await expect(connect.getByRole('button', { name: /Windows Terminal/ })).toBeVisible()
  await connect.getByRole('combobox', { name: 'Operating system' }).selectOption('windows')
  await expect(connect.getByRole('button', { name: /iTerm2/ })).toBeHidden()
  await expect(connect.getByRole('button', { name: /Terminal app/ })).toBeVisible()
  await connect.getByRole('combobox', { name: 'Operating system' }).selectOption('macos')
  await expect(connect.getByRole('button', { name: /Terminal app/ })).toBeVisible()
  const popupPromise = page.waitForEvent('popup')
  await connect.getByRole('button', { name: /Web terminal/ }).click()
  const popup = await popupPromise
  await expect(popup).toHaveTitle('Browser session · Browser box · Outpost')
  await expect(page).toHaveTitle('Outpost')
  await expect(connect).toBeHidden()
  expect(await popup.evaluate(() => window.opener)).toBeNull()
  expect(new URL(popup.url()).searchParams.has('token')).toBe(false)

  const terminal = popup.getByRole('dialog', { name: /Web terminal/ })
  await expect(terminal.getByText('Connected')).toBeVisible()
  await expect(terminal.locator('.xterm-rows')).toContainText('OUTPOST_FIXTURE_READY')
  await terminal.locator('input[type=file]').setInputFiles({ name: 'design.png', mimeType: 'image/png', buffer: png })
  await expect(terminal.getByRole('status')).toContainText('Image pasted')
  const input = terminal.getByRole('textbox', { name: 'Terminal input' })
  await input.pressSequentially('ring-bell')
  await input.press('Enter')
  await expect(popup).toHaveTitle('🔔 Browser session · Browser box rang a bell · Outpost')
  await expect(terminal.getByRole('status').filter({ hasText: 'rang a bell' })).toBeVisible()
  await terminal.getByRole('button', { name: 'Dismiss bell notification' }).click()
  await expect(popup).toHaveTitle('Browser session · Browser box · Outpost')
  await popup.reload()
  await expect(terminal.getByText('Connected')).toBeVisible()
  await expect(popup).toHaveTitle('Browser session · Browser box · Outpost')
  const closed = popup.waitForEvent('close')
  await terminal.getByRole('button', { name: 'Close terminal' }).click()
  await closed
  await expect(row).toContainText('Running')

  await row.getByRole('button', { name: `More actions for Browser session` }).click()
  await page.getByRole('menuitem', { name: 'Terminate' }).click()
  await page
    .getByRole('dialog', { name: /Terminate/ })
    .getByRole('button', { name: 'Terminate' })
    .click()
  await expect(row).toContainText('Stopped')
})

test('choosing a native terminal opens the link and confirms when the connector attaches', async ({ page }) => {
  await addTarget(page, 'Native box')
  await createSession(page, 'Native session', '~/native-project')
  await page.getByRole('row').filter({ hasText: 'Native session' }).getByRole('button', { name: 'Connect' }).click()
  const connect = page.getByRole('dialog', { name: 'Connect to Native session' })
  const response = page.waitForResponse(
    response => response.url().endsWith('/connect') && response.request().method() === 'POST',
  )
  await connect.getByRole('button', { name: /iTerm2/ }).click()
  const { url } = await (await response).json()
  expect(url).toMatch(/^outpost:\/\/connect\//)
  await expect(connect.getByText('Opening iTerm2…')).toBeVisible()
  await expect(connect.getByText('Nothing opened?')).toBeVisible({ timeout: 12_000 })
  await expect(connect.getByLabel('Connector install command')).toContainText(
    /^curl -fsSL 'http:\/\/127\.0\.0\.1:\d+\/connector\/install\.sh' \| bash$/,
  )

  // Play the part of the outpost:// handler: run the served connector on this link.
  const home = await mkdtemp(join(tmpdir(), 'outpost-connector-ui-'))
  const archive = join(home, 'outpost-connector.pyz')
  await writeFile(archive, Buffer.from(await (await page.request.get('/connector/outpost-connector.pyz')).body()))
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({ servers: [JSON.parse(Buffer.from(url.slice(18), 'base64url').toString()).server] }),
  )
  const connector = spawn(
    'python3',
    [join(fixtures, 'pty_driver.py'), '100', '30', '--', 'python3', archive, 'attach', url],
    { env: { ...process.env, OUTPOST_CONNECTOR_HOME: home, OUTPOST_CONNECTOR_FAKE: home } },
  )
  try {
    await expect(connect.getByText('Connected in iTerm2')).toBeVisible()
    await expect(page.getByRole('row').filter({ hasText: 'Native session' })).toContainText('Attached', {
      timeout: 20_000,
    })
  } finally {
    connector.kill()
    await rm(home, { recursive: true, force: true })
  }
})

test('Terminal app uses the connector flow and retries with a fresh ticket', async ({ page, context }) => {
  await addTarget(page, 'Desktop app box')
  await createSession(page, 'Desktop app session', '~/desktop-app-project')
  await page
    .getByRole('row')
    .filter({ hasText: 'Desktop app session' })
    .getByRole('button', { name: 'Connect' })
    .click()
  const connect = page.getByRole('dialog', { name: 'Connect to Desktop app session' })
  const response = () =>
    page.waitForResponse(response => response.url().endsWith('/connect') && response.request().method() === 'POST')
  const first = response()
  await connect.getByRole('button', { name: /Terminal app/ }).click()
  const firstTicket = await (await first).json()
  await expect(connect.getByText('Opening Terminal app…')).toBeVisible()
  const retry = response()
  await connect.getByRole('button', { name: 'Open Terminal app again' }).click()
  const next = await (await retry).json()
  expect(next.token).not.toBe(firstTicket.token)
  const payload = JSON.parse(Buffer.from(next.url.slice('outpost://connect/'.length), 'base64url').toString())
  expect(payload.terminal).toBe('terminal-app')
  // The OS launcher opens this URL; exercise the real browser client and broker.
  const app = await context.newPage()
  await app.goto(`/terminal/app#token=${payload.token}`)
  await expect(app.locator('.xterm-rows')).toContainText('OUTPOST_FIXTURE_READY')
  await expect(connect.getByText('Connected in Terminal app')).toBeVisible()
  await app.close()
})

test('phones get on-screen keys and a message box', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  await addTarget(page, 'Phone box')
  await createSession(page, 'Phone session', '~/phone-project')
  await page.getByRole('row').filter({ hasText: 'Phone session' }).getByRole('button', { name: 'Connect' }).click()
  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('button', { name: /Web terminal/ }).click()
  const popup = await popupPromise
  await expect(popup).toHaveTitle('Phone session · Phone box · Outpost')
  const terminal = popup.getByRole('dialog', { name: /Web terminal/ })
  await expect(terminal.getByText('Connected')).toBeVisible()
  await expect(terminal.getByRole('group', { name: 'Terminal keys' })).toBeVisible()
  await terminal.getByLabel('Message to the session').fill('hello from the phone')
  await terminal.getByRole('button', { name: 'Send' }).click()
  await expect(terminal.getByLabel('Message to the session')).toHaveValue('')
  await context.close()
})

test('fork suggests a dash-case worktree path and preserves a manual override', async ({ page }) => {
  await addTarget(page, 'Fork box')
  await createSession(page, 'Fork source', '~/fork-project')
  const source = page.getByRole('row').filter({ hasText: 'Fork source' })
  const root = await source.locator('code').innerText()
  const tool = await source.locator('.chip').innerText()
  await source.getByRole('button', { name: 'More actions for Fork source' }).click()
  await page.getByRole('menuitem', { name: 'Fork', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Fork Fork source', exact: true })
  const branch = dialog.getByLabel('New Git branch')
  const directory = dialog.getByLabel('Worktree directory')
  await branch.fill('feature/NewLogin_API')
  await expect(directory).toHaveValue(`${root}-feature-new-login-api`)
  await branch.fill('fix/HTTPError')
  await expect(directory).toHaveValue(`${root}-fix-http-error`)
  await directory.fill('~/chosen worktree')
  await branch.fill('feature/manual')
  await expect(directory).toHaveValue('~/chosen worktree')
  await dialog.getByRole('button', { name: 'Use suggested path' }).click()
  await expect(directory).toHaveValue(`${root}-feature-manual`)
  await directory.fill('~/chosen worktree')
  await dialog.getByRole('button', { name: 'Fork session', exact: true }).click()
  await expect(dialog).toBeHidden()
  const fork = page.getByRole('row').filter({ hasText: 'feature/manual' })
  await expect(fork).toContainText('chosen worktree')
  await expect(fork.locator('.chip')).toHaveText(tool)
  await expect(fork).toContainText('Not started')
  await expect(source).toBeVisible()

  // Forking from a linked worktree follows the same flow as a main checkout.
  await fork.getByRole('button', { name: 'More actions for feature/manual' }).click()
  await page.getByRole('menuitem', { name: 'Fork', exact: true }).click()
  const next = page.getByRole('dialog', { name: 'Fork feature/manual', exact: true })
  await next.getByLabel('New Git branch').fill('feature/AutoPath')
  await expect(next.getByLabel('Worktree directory')).toHaveValue(
    `${root.replace(/fork-project$/, 'chosen worktree')}-feature-auto-path`,
  )
  await next.getByRole('button', { name: 'Fork session', exact: true }).click()
  await expect(next).toBeHidden()
  await expect(page.getByRole('row').filter({ hasText: 'feature/AutoPath' })).toContainText(
    'chosen worktree-feature-auto-path',
  )
})

test('a failed worktree creation shows the error and creates no session', async ({ page }) => {
  await addTarget(page, 'Non-Git box')
  await createSession(page, 'Not a repository', '~/not-a-repository')
  const rows = page.getByRole('table', { name: 'Sessions' }).getByRole('row')
  const initialCount = await rows.count()
  const source = page.getByRole('row').filter({ hasText: 'Not a repository' })
  await source.getByRole('button', { name: 'More actions for Not a repository' }).click()
  await page.getByRole('menuitem', { name: 'Fork', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Fork Not a repository', exact: true })
  await dialog.getByLabel('New Git branch').fill('feature/rejected')
  const response = page.waitForResponse(
    response => response.url().endsWith('/fork') && response.request().method() === 'POST',
  )
  await dialog.getByRole('button', { name: 'Fork session', exact: true }).click()
  expect((await response).status()).toBe(409)
  await expect(dialog.getByRole('alert')).toContainText('not a git repository')
  await expect(dialog.getByLabel('New Git branch')).toHaveValue('feature/rejected')
  await expect(dialog.getByRole('button', { name: 'Fork session', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click()
  await expect(rows).toHaveCount(initialCount)
  await expect(rows.filter({ hasText: 'feature/rejected' })).toHaveCount(0)
  await expect(source).toBeVisible()
})
