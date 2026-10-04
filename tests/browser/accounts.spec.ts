import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Accounts } from '../../backend/accounts'
import type { AccountEmail } from '../../backend/account-email'
import { createApp } from '../../backend/app'
import type { Session } from '../../shared/session-manager'
import { healthySoftware } from './software-fixture'
import { codingIdentity } from './session-fixture'

test('real signup, verification, private workspaces, account settings, connection, recovery, and cross-tab logout', async ({ page, browser }) => {
  test.setTimeout(120_000)
  const directory = await mkdtemp(join(tmpdir(), 'outpost-auth-browser-'))
  const accounts = await Accounts.open({ directory, publicUrl: 'http://127.0.0.1:4178', production: false, mailer: null })
  const session: Session = {
    ...codingIdentity('codex', '12345678-1234-4123-8123-123456789012'),
    id: '12345678-1234-4123-8123-123456789012', name: 'My work', rootDir: '/root/project', tool: 'codex', backend: 'tmux',
    args: '', env: {}, createdAt: new Date().toISOString(), lastConnectedAt: null, status: 'idle', socketPath: '/root/.outpost/sockets/work',
    activity: { state: 'idle', updatedAt: null, completionId: null, detail: null },
  }
  const app = await createApp({
    accounts, frontendRoot: fileURLToPath(new URL('../../dist/client/', import.meta.url)),
    software: { inspect: async target => healthySoftware(target.backends, target.tools), plan: async () => { throw new Error('unused') }, install: async () => 0 },
    service: {
      list: async () => ({ sessions: [session], registryPath: '/root/.outpost/sessions.json' }), get: async () => session,
      create: async () => session, remove: async () => {}, terminate: async () => session, acknowledge: async () => session,
      directories: async () => ({ directories: [], truncated: false }), search: async () => ({ sessions: [], warnings: [], truncated: false }),
      pasteImage: async () => { throw new Error('unused') },
    },
  })
  const bobContext = await browser.newContext()
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 })
    accounts.publicUrl.port = new URL(origin).port
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    async function signup(subject: Page, email: string, name: string) {
      await subject.goto(`${origin}/signup`)
      await subject.getByRole('textbox', { name: 'Name', exact: true }).fill(name)
      await subject.getByRole('textbox', { name: 'Email', exact: true }).fill(email)
      await subject.getByLabel('Password', { exact: true }).fill('browser test password')
      await subject.getByLabel('Confirm password', { exact: true }).fill('browser test password')
      await subject.getByRole('button', { name: 'Create account' }).click()
      await expect(subject.getByRole('status')).toContainText('Account created')
      await subject.getByRole('link', { name: 'Open verification link' }).click()
      await subject.getByRole('button', { name: 'Verify email', exact: true }).click()
      await expect(subject.getByRole('button', { name: 'Add your first target' })).toBeVisible()
      await expect(subject.getByRole('heading', { name: 'Authorize your Outpost SSH key' })).toBeVisible()
    }
    await signup(page, 'alice-browser@example.com', 'Alice')
    await page.screenshot({ path: 'test-results/account-workspace.png', fullPage: true })
    await page.getByRole('button', { name: 'Add your first target' }).click()
    await expect(page.getByRole('combobox', { name: 'Connection type' }).locator('option')).toHaveCount(1)
    await page.getByRole('textbox', { name: 'Target name' }).fill('Alice server')
    await page.getByRole('textbox', { name: 'Host', exact: true }).fill('dev.example.com')
    await page.getByRole('dialog').getByRole('button', { name: 'Add target', exact: true }).click()
    await expect(page.getByText('Hosted service', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Connection options', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Connection options', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('Your computer needs its own SSH access')
    await expect(page.getByRole('button', { name: 'Launch terminal', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await page.getByRole('button', { name: /Alice — Your account/ }).click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Alice Updated')
    await page.getByRole('button', { name: 'Save profile' }).click()
    await expect(page.getByRole('status')).toContainText('Profile saved')
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await page.reload()
    await expect(page.getByRole('button', { name: /Alice Updated — Your account/ })).toBeVisible()
    const bob = await bobContext.newPage()
    await signup(bob, 'bob-browser@example.com', 'Bob')
    await expect(bob.getByRole('navigation', { name: 'Targets' })).not.toContainText('Alice server')
    const aliceTarget = new URL(page.url()).searchParams.get('target')!
    const foreign = await bob.request.get(`${origin}/api/targets/${aliceTarget}/sessions`)
    expect(foreign.status()).toBe(404)
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill('alice-browser@example.com')
    await page.getByLabel('Password', { exact: true }).fill('browser test password')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('navigation', { name: 'Targets' })).toContainText('Alice server')
    const secondTab = await page.context().newPage()
    await secondTab.goto(origin)
    await expect(secondTab.getByRole('navigation', { name: 'Targets' })).toContainText('Alice server')
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(secondTab.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await page.getByRole('link', { name: 'Forgot password?' }).click()
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill('alice-browser@example.com')
    await page.getByRole('button', { name: 'Send reset link' }).click()
    await page.getByRole('link', { name: 'Open password reset link' }).click()
    await page.getByLabel('Password', { exact: true }).fill('updated browser password')
    await page.getByLabel('Confirm password', { exact: true }).fill('updated browser password')
    await page.getByRole('button', { name: 'Reset password', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Password reset')
    await page.getByRole('link', { name: 'Back to sign in' }).click()
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill('alice-browser@example.com')
    await page.getByLabel('Password', { exact: true }).fill('updated browser password')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('navigation', { name: 'Targets' })).toContainText('Alice server')
    await page.getByRole('button', { name: /Alice Updated — Your account/ }).click()
    await page.locator('.account-password > summary').click()
    await page.getByLabel('Current password', { exact: true }).fill('updated browser password')
    await page.getByLabel('New password', { exact: true }).fill('final browser password')
    await page.getByLabel('Confirm new password', { exact: true }).fill('final browser password')
    await page.getByRole('button', { name: 'Change password', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  } finally { await bobContext.close(); await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test('account pages work on mobile and failed auth loading never opens the workspace', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('**/api/**', route => route.fulfill({ status: 503, json: { message: 'Account service unavailable' } }))
  await page.goto('/signup')
  await expect(page.getByRole('alert')).toHaveText('Account service unavailable')
  await expect(page.getByRole('button', { name: 'Add target' })).toHaveCount(0)
  await page.unroute('**/api/**')
  await page.route('**/api/**', route => route.fulfill({ json: { mode: 'hosted', user: null } }))
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('heading', { name: 'Give your work a home.' })).toBeVisible()
  await page.getByLabel('Password', { exact: true }).fill('test password')
  await page.getByRole('button', { name: 'Show password' }).click()
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/account-signup-mobile.png', fullPage: true })
})

test('production signup uses email delivery, HTTPS cookies, and the configured public address', async ({ page }) => {
  test.setTimeout(60_000)
  const directory = await mkdtemp(join(tmpdir(), 'outpost-production-browser-'))
  const messages: AccountEmail[] = []
  const accounts = await Accounts.open({ directory, publicUrl: 'https://outpost.example', production: true, mailer: async message => { messages.push(message) } })
  const app = await createApp({ accounts, frontendRoot: fileURLToPath(new URL('../../dist/client/', import.meta.url)) })
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 })
    // Simulate HTTPS termination while keeping the real production API and CSP.
    await page.route('https://outpost.example/**', async route => {
      const url = new URL(route.request().url())
      const response = await route.fetch({ url: origin + url.pathname + url.search, headers: { ...route.request().headers(), host: 'outpost.example' } })
      await route.fulfill({ response })
    })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto('https://outpost.example/signup')
    await expect(page.getByRole('heading', { name: 'Give your work a home.' })).toBeVisible()
    await page.screenshot({ path: 'test-results/account-signup-desktop.png', fullPage: true })
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Hosted User')
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill('hosted-browser@example.com')
    await page.getByLabel('Password', { exact: true }).fill('hosted test password')
    await page.getByLabel('Confirm password', { exact: true }).fill('hosted test password')
    await page.getByRole('button', { name: 'Create account' }).click()
    await expect(page.getByRole('status')).toContainText('Check your email')
    await expect(page.getByText('Local development email')).toHaveCount(0)
    expect(messages).toHaveLength(1)
    const verificationUrl = messages[0].html.match(/href="([^"]+)"/)![1].replaceAll('&amp;', '&')
    expect(new URL(verificationUrl).origin).toBe('https://outpost.example')
    await page.goto(verificationUrl)
    await page.getByRole('button', { name: 'Verify email', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Add your first target' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Hosted User — Your account/ })).toBeVisible()
    const cookie = (await page.context().cookies('https://outpost.example')).find(value => value.name === 'outpost_session')!
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' })
    await page.reload()
    await expect(page.getByRole('button', { name: /Hosted User — Your account/ })).toBeVisible()
    await expect(page.locator('.account-key pre')).toContainText('ssh-ed25519')
    expect(errors).toEqual([])
  } finally { await page.unrouteAll({ behavior: 'wait' }); await page.close(); await app.close(); await rm(directory, { recursive: true, force: true }) }
})
