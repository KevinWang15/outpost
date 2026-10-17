import { expect, test, type Page } from '@playwright/test'
import { desktopTerminal } from './terminal-fixture'

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
  await expect(connect.getByRole('button', { name: /Outpost Desktop/ })).toBeVisible()
  const popupPromise = page.waitForEvent('popup')
  await connect.getByRole('button', { name: /Web terminal/ }).click()
  const popup = await popupPromise
  await expect(popup).toHaveTitle('Browser session · Browser box · Outpost')
  await expect(page).toHaveTitle('Outpost')
  await expect(connect).toBeHidden()
  expect(await popup.evaluate(() => window.opener)).toBeNull()
  expect(new URL(popup.url()).searchParams.has('token')).toBe(false)

  const terminal = popup.getByRole('dialog', { name: /^Terminal ·/ })
  await expect(terminal.getByRole('status', { name: 'Connected', exact: true })).toBeVisible()
  await expect(terminal.locator('.xterm-rows')).toContainText('OUTPOST_FIXTURE_READY')
  await terminal.locator('input[type=file]').setInputFiles({ name: 'design.png', mimeType: 'image/png', buffer: png })
  await expect(terminal.getByRole('status').filter({ hasText: 'Image pasted' })).toBeVisible()
  const input = terminal.getByRole('textbox', { name: 'Terminal input' })
  await input.pressSequentially('ring-bell')
  await input.press('Enter')
  await expect(popup).toHaveTitle('🔔 Browser session · Browser box rang a bell · Outpost')
  await expect(terminal.getByRole('status').filter({ hasText: 'rang a bell' })).toBeVisible()
  await terminal.getByRole('button', { name: 'Dismiss bell notification' }).click()
  await expect(popup).toHaveTitle('Browser session · Browser box · Outpost')
  await popup.reload()
  await expect(terminal.getByRole('status', { name: 'Connected', exact: true })).toBeVisible()
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

test('Outpost Desktop uses the launch flow and retries with a fresh ticket', async ({ page, context }) => {
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
  await connect.getByRole('button', { name: /Outpost Desktop/ }).click()
  const firstTicket = await (await first).json()
  await expect(connect.getByText('Opening Outpost Desktop…')).toBeVisible()
  const retry = response()
  await connect.getByRole('button', { name: 'Open Outpost Desktop again' }).click()
  const next = await (await retry).json()
  expect(next.token).not.toBe(firstTicket.token)
  const payload = JSON.parse(Buffer.from(next.url.slice('outpost://connect/'.length), 'base64url').toString())
  expect(payload.terminal).toBe('desktop')
  // The OS launcher supplies the ticket through the preload; use the real broker.
  const app = await context.newPage()
  await desktopTerminal(app, payload.token)
  await app.goto('/terminal/desktop')
  await expect(app.locator('.xterm-rows')).toContainText('OUTPOST_FIXTURE_READY')
  await expect(connect.getByText('Connected in Outpost Desktop')).toBeVisible()
  await app.close()
})

test('phones get on-screen keys and a message box', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  await addTarget(page, 'Phone box')
  await createSession(page, 'Phone session', '~/phone-project')
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1)
  await page.getByRole('row').filter({ hasText: 'Phone session' }).getByRole('button', { name: 'Connect' }).tap()
  const popupPromise = page.waitForEvent('popup')
  await page.getByRole('button', { name: /Web terminal/ }).click()
  const popup = await popupPromise
  await expect(popup).toHaveTitle('Phone session · Phone box · Outpost')
  const terminal = popup.getByRole('dialog', { name: /^Terminal ·/ })
  await expect(terminal.getByRole('status', { name: 'Connected', exact: true })).toBeVisible()
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
