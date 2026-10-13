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
  await expect(connect.getByText('Native terminals')).toBeVisible()
  await expect(connect.getByRole('button', { name: /iTerm2/ })).toBeVisible()
  await expect(connect.getByRole('button', { name: /Windows Terminal/ })).toBeVisible()
  await connect.getByRole('combobox', { name: 'Operating system' }).selectOption('windows')
  await expect(connect.getByRole('button', { name: /iTerm2/ })).toBeHidden()
  await connect.getByRole('button', { name: /Web terminal/ }).click()

  const terminal = page.getByRole('dialog', { name: /Web terminal/ })
  await expect(terminal.getByText('Connected')).toBeVisible()
  await expect(terminal.locator('.xterm-rows')).toContainText('OUTPOST_FIXTURE_READY')
  await terminal.locator('input[type=file]').setInputFiles({ name: 'design.png', mimeType: 'image/png', buffer: png })
  await expect(terminal.getByRole('status')).toContainText('Image pasted')
  await terminal.getByRole('button', { name: 'Close terminal' }).click()
  await expect(row).toContainText('Running')

  await row.getByRole('button', { name: `More actions for Browser session` }).click()
  await page.getByRole('menuitem', { name: 'Terminate' }).click()
  await page.getByRole('dialog', { name: /Terminate/ }).getByRole('button', { name: 'Terminate' }).click()
  await expect(row).toContainText('Stopped')
})

test('choosing a native terminal opens the link and confirms when the connector attaches', async ({ page }) => {
  await addTarget(page, 'Native box')
  await createSession(page, 'Native session', '~/native-project')
  await page.getByRole('row').filter({ hasText: 'Native session' }).getByRole('button', { name: 'Connect' }).click()
  const connect = page.getByRole('dialog', { name: 'Connect to Native session' })
  const response = page.waitForResponse(response => response.url().endsWith('/connect') && response.request().method() === 'POST')
  await connect.getByRole('button', { name: /iTerm2/ }).click()
  const { url } = await (await response).json()
  expect(url).toMatch(/^outpost:\/\/connect\//)
  await expect(connect.getByText('Opening iTerm2…')).toBeVisible()
  await expect(connect.getByText('Nothing opened?')).toBeVisible({ timeout: 12_000 })
  await expect(connect.getByLabel('Connector install command')).toContainText(/^curl -fsSL 'http:\/\/127\.0\.0\.1:\d+\/connector\/install\.sh' \| bash$/)

  // Play the part of the outpost:// handler: run the served connector on this link.
  const home = await mkdtemp(join(tmpdir(), 'outpost-connector-ui-'))
  const archive = join(home, 'outpost-connector.pyz')
  await writeFile(archive, Buffer.from(await (await page.request.get('/connector/outpost-connector.pyz')).body()))
  await writeFile(join(home, 'config.json'), JSON.stringify({ servers: [JSON.parse(Buffer.from(url.slice(18), 'base64url').toString()).server] }))
  const connector = spawn('python3', [join(fixtures, 'pty_driver.py'), '100', '30', '--', 'python3', archive, 'attach', url],
    { env: { ...process.env, OUTPOST_CONNECTOR_HOME: home, OUTPOST_CONNECTOR_FAKE: home } })
  try {
    await expect(connect.getByText('Connected in iTerm2')).toBeVisible()
    await expect(page.getByRole('row').filter({ hasText: 'Native session' })).toContainText('Attached', { timeout: 20_000 })
  } finally { connector.kill(); await rm(home, { recursive: true, force: true }) }
})

test('phones get on-screen keys and a message box', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  await addTarget(page, 'Phone box')
  await createSession(page, 'Phone session', '~/phone-project')
  await page.getByRole('button', { name: 'Connect' }).first().click()
  await page.getByRole('button', { name: /Web terminal/ }).click()
  const terminal = page.getByRole('dialog', { name: /Web terminal/ })
  await expect(terminal.getByText('Connected')).toBeVisible()
  await expect(terminal.getByRole('group', { name: 'Terminal keys' })).toBeVisible()
  await terminal.getByLabel('Message to the session').fill('hello from the phone')
  await terminal.getByRole('button', { name: 'Send' }).click()
  await expect(terminal.getByLabel('Message to the session')).toHaveValue('')
  await context.close()
})
