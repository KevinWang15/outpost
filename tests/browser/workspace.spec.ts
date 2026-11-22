import type { Target, Session } from '../../shared/model'
import { desktopEntryUrl } from '../../shared/desktopAuth'
import { unavailableActivity } from '../../shared/activity'
import { expect, test, type Page } from './fixtures'
import { appConnection } from './terminal-fixture'

const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 9)])

async function addMachine(page: Page, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add a machine' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Add a machine' })
  await dialog.getByRole('button', { name: 'Run sessions on this computer' }).click()
  await dialog.getByRole('button', { name: 'Back' }).click()
  await expect(dialog.getByRole('tab', { name: 'Connect over SSH' })).toBeFocused()
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(dialog.getByLabel('Host', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Back' }).click()
  await dialog.getByRole('button', { name: 'Run sessions on this computer' }).click()
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

test('remote setup offers SSH with a bastion or one outbound install command and the same coding tools', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Add a machine' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Add a machine' })
  const next = dialog.getByRole('button', { name: 'Continue' })
  await expect(dialog.getByRole('tab', { name: 'Connect over SSH' })).toBeFocused()
  await next.click()
  await dialog.getByLabel('Host', { exact: true }).fill('build.example.test')
  await dialog.getByText('Use an SSH bastion').click()
  await expect(dialog.getByLabel('Bastion host', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Back' }).click()
  await dialog.getByRole('tab', { name: 'Run setup on the machine' }).click()
  await next.click()
  await dialog.getByLabel('Name', { exact: true }).fill('Outbound installer')
  await dialog.getByRole('checkbox', { name: 'DeepSeek Harness' }).check()
  await dialog.getByRole('button', { name: 'Add machine' }).click()
  const panel = page.getByRole('region', { name: 'Machine installation' })
  await panel.getByRole('button', { name: 'Get install command' }).click()
  const command = panel.getByLabel('Install command', { exact: true })
  await expect(command).toContainText('/api/install/machine.sh')
  const first = await command.innerText()
  await panel.getByRole('button', { name: 'Generate new command' }).click()
  await expect(command).not.toHaveText(first)
})

test('Machines offers a terminal for an ACP-only session and stops offering creation when its machine disconnects', async ({
  page,
  request,
}) => {
  const response = await request.post('/api/targets', {
    headers: { 'x-outpost-request': '1' },
    data: { kind: 'outbound', name: 'Build host', tools: ['deepseek'] },
  })
  expect(response.status()).toBe(201)
  const target: Target = await response.json()
  const api = '**/api/targets/' + target.id
  let connected = true
  await page.route(api + '/enrollment', route => route.fulfill({ json: { enrolled: true, connected } }))
  await page.route(api + '/installations', route => route.fulfill({ json: { installation: null } }))
  await page.route(api + '/software', route =>
    route.fulfill({
      json: {
        software: ['bash', 'outpost-terminal', 'deepseek'].map(id => ({ id, status: 'installed', version: 'fixture' })),
      },
    }),
  )
  const now = new Date().toISOString()
  const session: Session = {
    id: crypto.randomUUID(),
    name: 'DeepSeek review',
    tool: 'deepseek',
    rootDir: '/work',
    createdAt: now,
    lastConnectedAt: null,
    storage: {},
    delivery: 'auto',
    config: { revision: 1, instructions: null, model: null, mode: null, mcpServers: {}, args: '', env: {} },
    conversations: [{ id: crypto.randomUUID(), title: null, startedAt: now, movedTo: null }],
    title: null,
    status: 'ready',
    driver: null,
    runningRevision: null,
    activity: unavailableActivity('Not started'),
  }
  await page.route(api + '/sessions', route => route.fulfill({ json: { sessions: [session] } }))
  await page.clock.install()
  await page.goto('/')
  const row = page.getByRole('row').filter({ hasText: session.name })
  await expect(row.getByRole('link', { name: 'Open in chat' })).toBeVisible()
  await row.getByRole('button', { name: 'More actions for ' + session.name }).click()
  await page.getByRole('menuitem', { name: 'Open in Terminal' }).click()
  const connect = page.getByRole('dialog', { name: 'Connect to ' + session.name })
  await expect(connect.getByRole('button', { name: /Outpost Desktop/ })).toContainText('tabs and split panes')
  await page.keyboard.press('Escape')
  const start = page.getByRole('button', { name: 'New session', exact: true }).first()
  await start.click()
  const creator = page.getByRole('dialog', { name: 'New session' })
  await expect(creator.getByRole('button', { name: 'Create session' })).toBeEnabled()
  connected = false
  await page.clock.fastForward('00:16')
  await expect(creator.getByRole('button', { name: 'Create session' })).toBeDisabled()
  await creator.getByRole('button', { name: 'Cancel' }).click()
  await expect(start).toBeDisabled()
  await expect(start).toHaveAttribute('title', 'Connect the machine first')
  await page.getByRole('button', { name: 'Actions for Build host' }).click()
  await page.getByRole('menuitem', { name: 'Remove machine' }).click()
  await expect(page.getByRole('dialog', { name: 'Remove Build host?' })).toContainText('outpost-terminal unenroll')
})

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
  await expect(row).toContainText('Native CLI')

  await row.getByRole('button', { name: `More actions for Browser session` }).click()
  await page.getByRole('menuitem', { name: 'Stop coding tool' }).click()
  await page
    .getByRole('dialog', { name: 'Stop Browser session?' })
    .getByRole('button', { name: 'Stop coding tool' })
    .click()
  await expect(row).toContainText('Not running')
})

test('Chat joins a running CLI and displays both terminal and Chat turns', async ({ page, context }) => {
  await addMachine(page, 'Shared machine')
  await createSession(page, 'Shared agent', '~/shared-terminal')
  await page.evaluate(() => localStorage.setItem('outpost.connection.terminal', 'web'))
  const row = page.getByRole('row').filter({ hasText: 'Shared agent' })
  const opened = context.waitForEvent('page')
  await row.getByRole('button', { name: 'Connect' }).click()
  const terminal = await opened
  await expect(terminal.locator('.xterm-rows')).toContainText('OUTPOST_FIXTURE_READY')
  const input = terminal.getByRole('textbox', { name: 'Terminal input' })
  await input.pressSequentially('From the keyboard')
  await input.press('Enter')
  await row.getByRole('button', { name: 'More actions for Shared agent' }).click()
  await page.getByRole('menuitem', { name: 'Open in Chat' }).click()
  await expect(page.locator('.reply .markdown').last()).toContainText('Fixture reply to: From the keyboard')
  const composer = page.getByRole('textbox', { name: 'Message' })
  await composer.fill('From Chat')
  await composer.press('Enter')
  await expect(page.locator('.reply .markdown').last()).toContainText('Fixture reply to: From Chat')
  await expect(terminal.getByRole('status', { name: 'Connected', exact: true })).toBeVisible()
})

test('Outpost Desktop hands off a session reference and uses app-owned access', async ({ page }) => {
  await page.goto('/desktop')
  await expect(page.getByRole('link', { name: 'Connect the installed app to this server' })).toHaveAttribute(
    'href',
    desktopEntryUrl({ server: new URL(page.url()).origin }),
  )
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
