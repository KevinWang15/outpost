import { expect, test, type Page } from '@playwright/test'
import { healthySoftware } from './software-fixture'

const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII='
const png = Buffer.from(data, 'base64')
const sessions = [
  { id: 'tmux-work', name: 'Codex work', backend: 'tmux', tool: 'codex', activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: 'detached' },
  { id: 'dtach-work', name: 'Kimi work', backend: 'dtach', tool: 'kimi', activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: 'idle' },
  { id: 'stopped-work', name: 'Claude work', backend: 'tmux', tool: 'claude', activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: 'stopped' },
].map(session => ({ ...session, rootDir: '/home/dev/project', env: {}, args: '', socketPath: `/home/dev/.outpost/sockets/${session.id}.sock`, createdAt: '2026-09-30T00:00:00Z', lastConnectedAt: null }))

async function setup(page: Page) {
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/auth/session') return route.fulfill({ json: { mode: 'local', user: null } })
    const path = new URL(route.request().url()).pathname
    if (path === '/api/environment') return route.fulfill({ json: { platform: 'linux', supported: true, usesWsl: false } })
    if (path === '/api/targets') return route.fulfill({ json: [{ id: 'images', kind: 'ssh', name: 'Images', host: 'dev.example.com', backends: ['tmux', 'dtach'], tools: ['codex', 'kimi', 'claude'], createdAt: '2026-09-30T00:00:00Z' }] })
    if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware(['tmux', 'dtach'], ['codex', 'kimi', 'claude']) })
    if (path.endsWith('/sessions')) return route.fulfill({ json: { sessions, registryPath: '/home/dev/.outpost/sessions.json' } })
    throw new Error(`Unexpected request: ${route.request().method()} ${path}`)
  })
  await page.goto('/')
  await expect(page.getByText('Codex work', { exact: true })).toBeVisible()
}

async function transfer(page: Page, event: 'paste' | 'drop') {
  await page.getByRole('group', { name: 'Paste an image from the clipboard' }).evaluate((zone, args) => {
    const clipboard = new DataTransfer()
    clipboard.items.add(new File([Uint8Array.from(atob(args.data), character => character.charCodeAt(0))], 'clipboard.png', { type: 'image/png' }))
    zone.dispatchEvent(args.event === 'paste'
      ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard })
      : new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: clipboard }))
  }, { data, event })
}

test('browsed image uploads are scoped to their session and the pending dialog cannot be dismissed or changed', async ({ page }) => {
  let complete!: () => void
  const pending = new Promise<void>(resolve => { complete = resolve })
  const uploads: unknown[] = []
  await setup(page)
  await page.route('**/api/targets/images/sessions/tmux-work/image', async route => {
    expect(route.request().headers()['x-outpost-request']).toBe('1')
    uploads.push(route.request().postDataJSON())
    await pending
    await route.fulfill({ json: { path: '/home/dev/image.png', reference: '/home/dev/image.png', injected: true } })
  })
  await page.getByRole('button', { name: 'Attach an image to Codex work', exact: true }).click()
  await page.getByLabel('Choose image file').setInputFiles({ name: 'first.png', mimeType: 'image/png', buffer: png })
  await expect(page.getByAltText('Clipboard image preview')).toBeVisible()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Browse images' }).click()
  await (await chooser).setFiles({ name: 'second.png', mimeType: 'image/png', buffer: png })
  await page.getByRole('button', { name: 'Send to session' }).click()
  await expect.poll(() => uploads.length).toBe(1)
  await expect(page.getByRole('button', { name: 'Uploading…' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Close dialog' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
  await expect(page.getByLabel('Choose image file')).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeVisible()
  complete()
  await expect(page.getByRole('status')).toContainText('pasted into the session input')
  await expect(page.getByRole('status')).toContainText('Codex')
  expect(uploads).toEqual([{ data, mediaType: 'image/png' }])
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('canceling the native file picker keeps the image dialog and its current selection', async ({ page }) => {
  await setup(page)
  await page.getByRole('button', { name: 'Attach an image to Codex work', exact: true }).click()
  const input = page.getByLabel('Choose image file')
  await input.setInputFiles({ name: 'valid.png', mimeType: 'image/png', buffer: png })
  await input.dispatchEvent('cancel')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByAltText('Clipboard image preview')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send to session' })).toBeEnabled()
})

test('invalid files clear a previous selection, oversized files are rejected, and failed uploads can be retried', async ({ page }) => {
  let attempts = 0
  await setup(page)
  await page.route('**/api/targets/images/sessions/tmux-work/image', async route => {
    attempts++
    return attempts === 1
      ? route.fulfill({ status: 502, json: { message: 'SSH unavailable; retry' } })
      : route.fulfill({ json: { path: '/home/dev/image.png', reference: '/home/dev/image.png', injected: true } })
  })
  await page.getByRole('button', { name: 'Attach an image to Codex work', exact: true }).click()
  const input = page.getByLabel('Choose image file')
  await input.setInputFiles({ name: 'valid.png', mimeType: 'image/png', buffer: png })
  await input.setInputFiles({ name: 'wrong.txt', mimeType: 'text/plain', buffer: Buffer.from('text') })
  await expect(page.getByRole('alert')).toContainText('not a PNG')
  await expect(page.getByAltText('Clipboard image preview')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Send to session' })).toBeDisabled()
  await input.setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(16 * 1024 * 1024 + 1) })
  await expect(page.getByRole('alert')).toContainText('limited to 16 MB')
  expect(attempts).toBe(0)
  await transfer(page, 'paste')
  await page.getByRole('button', { name: 'Send to session' }).click()
  await expect(page.getByRole('alert')).toHaveText('SSH unavailable; retry')
  await expect(page.getByAltText('Clipboard image preview')).toBeVisible()
  await page.getByRole('button', { name: 'Send to session' }).click()
  await expect(page.getByRole('status')).toContainText('pasted into the session input')
  expect(attempts).toBe(2)
})

for (const name of ['Kimi work', 'Claude work']) test(`${name}: pasted and dropped images offer a copy reference when automatic paste is unavailable`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await setup(page)
  const uploads: unknown[] = []
  const session = sessions.find(session => session.name === name)!
  const reference = `/home/dev/.outpost/clipboard/${session.id}/image.png`
  await page.route(`**/api/targets/images/sessions/${session.id}/image`, async route => {
    uploads.push(route.request().postDataJSON())
    await route.fulfill({ json: { path: reference, reference, injected: false } })
  })
  await page.getByRole('button', { name: `Attach an image to ${name}`, exact: true }).click()
  await transfer(page, name === 'Kimi work' ? 'paste' : 'drop')
  await expect(page.getByAltText('Clipboard image preview')).toBeVisible()
  await page.getByRole('button', { name: 'Send to session' }).click()
  await expect(page.getByRole('status')).toContainText('Automatic paste is unavailable')
  await expect(page.getByRole('dialog')).not.toContainText('tmux, which cannot')
  await expect(page.getByRole('dialog').locator('code')).toHaveText(reference)
  await page.getByRole('button', { name: 'Copy reference' }).click()
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(reference)
  expect(uploads).toEqual([{ data, mediaType: 'image/png' }])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: `test-results/image-attach-${session.backend}-${session.status}.png` })
})
