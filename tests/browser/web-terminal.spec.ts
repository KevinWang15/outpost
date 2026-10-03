import { expect, test } from '@playwright/test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../../backend/app'
import { Accounts } from '../../backend/accounts'
import { webSshFixture } from '../fixtures/web-ssh'
import { healthySoftware } from './software-fixture'
import { codingIdentity } from './session-fixture'
import type { Session } from '../../shared/session-manager'

test('mobile web terminal is opt-in: file upload, SSH input, phone keys, resize, reconnect, key removal and saved-key launch', async ({ page }) => {
  test.setTimeout(60000)
  await page.setViewportSize({ width: 390, height: 844 })
  const directory = await mkdtemp(join(tmpdir(), 'outpost-terminal-browser-')), ssh = await webSshFixture()
  const accounts = await Accounts.open({ directory, publicUrl: 'http://127.0.0.1:4178', production: false, mailer: null })
  const user = accounts.store.create('mobile@example.com', 'Mobile Dev', 'unused')
  const verified = accounts.store.consumeToken(accounts.store.issueToken(user.id, 'verify', 10000), 'verify')!
  const login = accounts.store.issueSession(verified)
  const session: Session = { ...codingIdentity('codex', '12345678-1234-4123-8123-123456789012'), id: '12345678-1234-4123-8123-123456789012', name: 'Phone work', backend: 'tmux', tool: 'codex', rootDir: '/root/project', env: {}, args: '', createdAt: new Date().toISOString(), lastConnectedAt: null, status: 'detached', socketPath: '/root/.outpost/sockets/test', activity: { state: 'idle', updatedAt: null, completionId: null, detail: null } }
  const target = await accounts.targetStore(user.id).add({ id: '12345678-1234-4123-8123-123456789011', createdAt: new Date().toISOString(), name: 'Mobile SSH', kind: 'ssh', host: '127.0.0.1', port: ssh.port, backends: ['tmux'], tools: ['codex'] })
  const app = await createApp({ accounts, frontendRoot: fileURLToPath(new URL('../../dist/client/', import.meta.url)), service: { list: async () => ({ sessions: [session], registryPath: '/root/.outpost/sessions.json' }), get: async () => session } as never, software: { inspect: async () => healthySoftware(['tmux'], ['codex']) } as never })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address() as { port: number }, origin = `http://127.0.0.1:${address.port}`
  await page.context().addCookies([{ name: 'outpost_session', value: login.token, url: origin, httpOnly: true, sameSite: 'Lax' }])
  const errors: string[] = [], webRequests: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (/terminal-key|web-terminal/.test(request.url()) && request.url().includes('/api/')) webRequests.push(request.url()) })
  try {
    await page.goto(`${origin}/?target=${target.id}`)
    await expect(page.getByText('Phone work', { exact: true })).toBeVisible()
    expect(webRequests).toEqual([]); expect(ssh.commands).toEqual([])
    await page.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Connect to Phone work' })).toBeVisible()
    expect(webRequests).toEqual([]); expect(ssh.commands).toEqual([])
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    const openMenu = async () => { await page.getByRole('button', { name: 'Connection options for Phone work' }).click(); await page.getByRole('menuitem', { name: 'Launch with web terminal' }).click() }
    await openMenu()
    await expect(page.getByRole('heading', { name: 'Web terminal · Phone work' })).toBeVisible()
    await expect(page.getByText('Add your SSH private key', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save key and launch' })).toBeDisabled()
    expect(ssh.commands).toEqual([])
    await page.getByLabel('Private key file', { exact: true }).setInputFiles({ name: 'phone-key', mimeType: 'application/octet-stream', buffer: Buffer.from(ssh.key) })
    await page.getByRole('button', { name: 'Save key and launch' }).click()
    await expect(page.locator('.terminal-toolbar')).toContainText('Connected')
    await expect(page.getByLabel('Private key', { exact: true })).toHaveCount(0)
    await expect(page.locator('.xterm-screen')).toBeVisible()
    expect(await page.getByRole('dialog').evaluate(dialog => dialog.matches(':modal'))).toBe(true)
    await expect.poll(async () => (await page.getByRole('dialog').boundingBox())!.y).toBe(0)
    expect((await page.getByRole('dialog').boundingBox())!.height).toBeLessThanOrEqual(844)
    await expect.poll(() => ssh.sizes.some(size => size[0] < 60)).toBe(true)
    expect(await page.getByRole('dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true)
    await page.getByLabel('Terminal text', { exact: true }).fill('hello from phone')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => ssh.inputs.join('')).toContain('hello from phone\r')
    for (const name of ['Esc', 'Tab', '↑', 'Ctrl+C', 'Shift+Enter']) await page.getByRole('button', { name, exact: true }).click()
    await expect.poll(() => ssh.inputs.join('')).toContain('\x1b\t\x1b[A\x03\x1b[13;2u')
    await page.getByRole('button', { name: 'Ctrl', exact: true }).click()
    await page.getByRole('textbox', { name: 'Terminal input' }).press('a')
    await expect.poll(() => ssh.inputs.join('')).toContain('\x01')
    await page.screenshot({ path: 'test-results/web-terminal-mobile.png' })
    await page.setViewportSize({ width: 844, height: 390 })
    await expect.poll(() => ssh.sizes.some(size => size[0] > 60)).toBe(true)
    await expect(page.getByRole('dialog')).toHaveClass(/terminal-compact/)
    expect((await page.getByRole('button', { name: 'Send', exact: true }).boundingBox())!.y).toBeLessThan(350)
    await page.setViewportSize({ width: 390, height: 390 })
    await expect(page.getByRole('dialog')).toHaveClass(/terminal-compact/)
    expect((await page.getByRole('button', { name: 'Send', exact: true }).boundingBox())!.y).toBeLessThan(350)
    await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toBeInViewport()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Manage key', exact: true }).click()
    await expect(page.getByText('Private key for this target', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Return to terminal' }).click()
    await expect(page.locator('.terminal-toolbar')).toContainText('Connected')
    expect(ssh.commands).toHaveLength(1)
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await openMenu(); await expect(page.locator('.terminal-toolbar')).toContainText('Connected')
    expect(ssh.commands).toHaveLength(2)
    await page.getByRole('button', { name: 'Manage key', exact: true }).click()
    await page.getByRole('button', { name: 'Remove saved key', exact: true }).click()
    await expect(page.getByText('Add your SSH private key', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
    const stored = await page.request.put(`${origin}/api/targets/${target.id}/terminal-key`, { headers: { 'x-outpost-request': '1' }, data: { privateKey: ssh.key } })
    expect(stored.status()).toBe(200)
    const vault = join(directory, 'terminal-keys'), file = (await readdir(vault)).find(name => name.endsWith('.json'))!
    const encrypted = JSON.parse(await readFile(join(vault, file), 'utf8'))
    encrypted.tag = Buffer.alloc(16).toString('base64')
    await writeFile(join(vault, file), JSON.stringify(encrypted))
    await openMenu()
    await expect(page.getByRole('alert')).toContainText('cannot be decrypted')
    await page.getByRole('button', { name: 'Remove saved key', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Save key and launch' })).toBeDisabled()
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
    expect(errors).toEqual([])
  } finally { await page.close(); await app.close(); await ssh.close(); await rm(directory, { recursive: true, force: true }) }
})
