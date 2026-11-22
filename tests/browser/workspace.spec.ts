import type { Target, Session } from '../../shared/model'
import { expect, test, type Page } from '@playwright/test'
import { appConnection } from './terminal-fixture'

const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 9)])

async function addMachine(page: Page, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add a machine' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Add a machine' })
  await dialog.getByRole('tab', { name: 'On the Outpost server' }).click()
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByText('Codex').click()
  await dialog.getByRole('button', { name: 'Add machine' }).click()
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Required software' })).toContainText('Ready')
}

async function createSession(page: Page, name: string, directory: string) {
  await page.getByRole('button', { name: 'New session' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New session' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('combobox', { name: 'Project directory' }).fill(directory)
  await dialog.getByText('Create the directory if it doesn’t exist').click()
  await dialog.getByRole('button', { name: 'Create session' }).click()
  await expect(page.getByRole('row').filter({ hasText: name })).toBeVisible()
}

test('direct-only setup offers terminal tools and restores Chat tools for server-connected machines', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add a machine', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Add a machine' })
  const deepseek = dialog.getByRole('checkbox', { name: 'DeepSeek Harness' })
  const next = dialog.getByRole('button', { name: 'Continue' })
  const back = dialog.getByRole('button', { name: 'Back' })
  await expect(dialog.getByRole('tab', { name: 'SSH', exact: true })).toBeFocused()
  await next.click()
  await dialog.getByLabel('Host', { exact: true }).fill('build.example.test')
  await deepseek.check()
  await back.click()
  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('tab', { name: 'Direct only' })).toBeFocused()
  await expect(dialog.getByRole('tabpanel')).toContainText('Get install command')
  await next.click()
  await expect(deepseek).toHaveCount(0)
  await dialog.getByRole('checkbox', { name: 'Codex' }).check()
  await back.click()
  await dialog.getByRole('tab', { name: 'SSH', exact: true }).click()
  await next.click()
  await expect(dialog.getByLabel('Host', { exact: true })).toHaveValue('build.example.test')
  await expect(deepseek).toBeChecked()
})

for (const method of ['Direct only', 'Relay enabled']) {
  test(`${method} offers an install command for the new machine`, async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Add a machine' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Add a machine' })
    await dialog.getByRole('tab', { name: method }).click()
    await dialog.getByRole('button', { name: 'Continue' }).click()
    await dialog.getByLabel('Name', { exact: true }).fill(`Installer test · ${method}`)
    if (method === 'Direct only') await dialog.getByLabel(/Machine HTTPS address/).fill('https://machine.example.test')
    await dialog.getByRole('button', { name: 'Add machine' }).click()
    const panel = page.getByRole('region', { name: 'Machine installation' })
    await panel.getByRole('button', { name: 'Get install command' }).click()
    const command = panel.getByLabel('Install command', { exact: true })
    await expect(command).toContainText('/api/install/machine.sh')
    if (method === 'Direct only') {
      await expect(command).toContainText('sh -s -- direct')
      await panel.getByText('Install without outbound access', { exact: true }).click()
      await expect(panel.getByLabel('Offline install command')).toContainText('sh ./machine.sh direct')
    } else {
      await expect(command).toContainText('sh -s -- relay')
      const first = await command.innerText()
      await panel.getByRole('button', { name: 'Generate new command' }).click()
      await expect(command).not.toHaveText(first)
    }
  })
}

test('add a machine, create a session, and work in the web terminal', async ({ page }) => {
  await addMachine(page, 'Browser box')
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
  await expect(row).toContainText('In a terminal')

  await row.getByRole('button', { name: `More actions for Browser session` }).click()
  await page.getByRole('menuitem', { name: 'Stop coding tool' }).click()
  await page
    .getByRole('dialog', { name: 'Stop Browser session?' })
    .getByRole('button', { name: 'Stop coding tool' })
    .click()
  await expect(row).toContainText('Not running')
})

test('Outpost Desktop hands off a session reference and uses app-owned access', async ({ page }) => {
  await addMachine(page, 'Desktop app box')
  await createSession(page, 'Desktop app session', '~/desktop-app-project')
  await page
    .getByRole('row')
    .filter({ hasText: 'Desktop app session' })
    .getByRole('button', { name: 'Connect' })
    .click()
  const connect = page.getByRole('dialog', { name: 'Connect to Desktop app session' })
  const requests: string[] = []
  page.on('request', request => {
    if (request.url().endsWith('/connect')) requests.push(request.url())
  })
  await connect.getByRole('button', { name: /Outpost Desktop/ }).click()
  await expect(connect.getByText('Continue in Outpost Desktop')).toBeVisible()
  await connect.getByRole('button', { name: 'Open Outpost Desktop again' }).click()
  expect(requests).toEqual([])
  const targets = (await (await page.request.get('/api/targets')).json()) as Target[]
  const target = targets.find(item => item.name === 'Desktop app box')!
  const { sessions } = (await (await page.request.get(`/api/targets/${target.id}/sessions`)).json()) as {
    sessions: Session[]
  }
  const session = sessions.find(item => item.name === 'Desktop app session')!
  const launch = await appConnection(page.request, target.id, session.id)
  expect(launch.token).toBeTruthy()
  expect(launch.sessionId).toBe(session.id)
})

test('phones get on-screen keys and a message box', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  await addMachine(page, 'Phone box')
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
  await addMachine(page, 'Fork box')
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
  await addMachine(page, 'Non-Git box')
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
