import { expect, test, type Page } from '@playwright/test'
import { webTerminalWorkspace as workspace } from './web-terminal-fixture'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII='
const reference = '/root/.outpost/clipboard/work/image.png'
const pasted = `\x1b[200~${reference}\x1b[201~`

async function clipboardImage(page: Page) {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 8
    canvas.getContext('2d')!.fillRect(0, 0, 8, 8)
    const image = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': image, 'text/plain': new Blob(['image alternative text'], { type: 'text/plain' }) })])
  })
}

async function imageEvent(page: Page, type = 'image/png', size?: number) {
  await page.getByLabel('Terminal input', { exact: true }).evaluate((element, image) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', 'image alternative text')
    clipboardData.items.add(new File([image.size ? new Uint8Array(image.size) : Uint8Array.from(atob(image.png), byte => byte.charCodeAt(0))], 'clipboard.png', { type: image.type }))
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  }, { png, type, size })
}

test.beforeEach(async ({ context }) => { await context.grantPermissions(['clipboard-read', 'clipboard-write']) })

for (const backend of ['tmux', 'dtach'] as const) test(`${backend}: real image paste shortcuts and the Paste button upload automatically without Enter or duplicate text`, async ({ page }) => {
  const state = await workspace(page, { backend })
  const draft = page.getByLabel('Terminal text', { exact: true })
  await draft.fill('keep this unsent draft')
  await clipboardImage(page)
  await page.getByRole('button', { name: 'Ctrl', exact: true }).click()
  await page.getByLabel('Terminal input', { exact: true }).press('Control+v')
  await expect.poll(() => state.uploads.length).toBe(1)
  await expect(page.locator('.terminal-image-paste')).toHaveCount(0)
  expect(state.uploads[0].mediaType).toBe('image/png')
  expect(Buffer.from(state.uploads[0].data, 'base64').subarray(1, 4).toString()).toBe('PNG')
  await expect(page.getByRole('button', { name: 'Ctrl', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: 'Paste', exact: true }).click()
  await expect.poll(() => state.uploads.length).toBe(2)
  await expect(page.locator('.terminal-image-paste')).toHaveCount(0)
  expect(state.inputs).toEqual(backend === 'tmux' ? [] : [pasted, pasted])
  await expect(draft).toHaveValue('keep this unsent draft')
  await expect(page.getByAltText('Terminal image preview')).toHaveCount(0)
  expect(state.errors).toEqual([])
})

test('delayed clipboard image reads cannot cross a reconnect and multiple images are rejected before uploading', async ({ page }) => {
  const state = await workspace(page)
  const sockets = state.sockets.length
  await page.evaluate(data => {
    navigator.clipboard.read = async () => [new ClipboardItem({ 'image/png': new Promise<Blob>(resolve => {
      document.body.dataset.imageReadPending = 'true'
      document.addEventListener('finish-image-read', () => resolve(new Blob([Uint8Array.from(atob(data), byte => byte.charCodeAt(0))], { type: 'image/png' })), { once: true })
    }) })]
  }, png)
  await page.getByRole('button', { name: 'Paste', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.body.dataset.imageReadPending)).toBe('true')
  state.disconnect()
  await expect.poll(() => state.sockets.length).toBe(sockets + 1)
  state.reconnect()
  await expect(page.locator('.terminal-toolbar')).toContainText('Connected')
  await page.evaluate(() => document.dispatchEvent(new Event('finish-image-read')))
  await page.getByLabel('Terminal input', { exact: true }).evaluate(element => {
    const clipboardData = new DataTransfer()
    for (const name of ['one.png', 'two.png']) clipboardData.items.add(new File(['image'], name, { type: 'image/png' }))
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  })
  await expect(page.locator('.terminal-clipboard-status')).toHaveText('Paste one image at a time.')
  expect(state.uploads).toEqual([])
  expect(state.inputs).toEqual([])
  expect(state.errors).toEqual([])
})

test.describe('phone image paste', () => {
  test.use({ viewport: { width: 360, height: 300 }, isMobile: true, hasTouch: true })
  test('an upload failure keeps Send and clipboard controls reachable with the phone keyboard open', async ({ page }) => {
    const state = await workspace(page, { hosted: true, backend: 'dtach' })
    state.onUpload(route => route.fulfill({ status: 502, json: { message: 'Target unavailable. The connection to the image upload service was interrupted.' } }))
    await imageEvent(page)
    await expect(page.getByRole('alert')).toContainText('Target unavailable')
    for (const name of ['Send', 'Copy', 'Paste']) await expect(page.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 })
    await page.getByRole('button', { name: 'Retry image paste', exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByRole('button', { name: 'Retry image paste', exact: true })).toBeInViewport({ ratio: 1 })
    expect((await page.locator('.terminal-surface').boundingBox())!.height).toBeGreaterThan(0)
    await page.screenshot({ path: 'test-results/terminal-image-paste-phone.png' })
    await page.getByRole('button', { name: 'Dismiss', exact: true }).tap()
    await expect(page.locator('.terminal-image-paste')).toHaveCount(0)
    expect(state.errors).toEqual([])
  })
})

test('an image upload owns one paste, preserves normal clipboard text, and retains a failed image for explicit retry', async ({ page }) => {
  const state = await workspace(page, { backend: 'dtach' })
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  state.onUpload(async route => { await pending; await route.fulfill({ status: 502, json: { message: 'Target unavailable' } }) })
  await imageEvent(page)
  await expect(page.locator('.terminal-image-paste')).toContainText('Uploading image')
  await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await imageEvent(page)
  expect(state.uploads).toHaveLength(1)
  expect(state.inputs).toEqual([])
  release()
  await expect(page.getByRole('alert')).toContainText('Target unavailable')
  await page.evaluate(() => navigator.clipboard.writeText('new clipboard contents'))
  state.onUpload(route => route.fulfill({ json: { path: reference, reference, injected: false } }))
  await page.getByRole('button', { name: 'Retry image paste', exact: true }).click()
  await expect(page.locator('.terminal-image-paste')).toHaveCount(0)
  expect(state.uploads).toEqual([{ data: png, mediaType: 'image/png' }, { data: png, mediaType: 'image/png' }])
  expect(state.inputs).toEqual([pasted])
  await page.getByRole('button', { name: 'Paste', exact: true }).click()
  await expect.poll(() => state.inputs).toEqual([pasted, '\x1b[200~new clipboard contents\x1b[201~'])
  expect(state.errors).toEqual([])
})

test('a reconnect during upload requires explicit reference insertion and does not upload the image again', async ({ page }) => {
  const state = await workspace(page, { backend: 'dtach' })
  const sockets = state.sockets.length
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  state.onUpload(async route => { await pending; await route.fulfill({ json: { path: reference, reference, injected: false } }) })
  await imageEvent(page)
  await expect.poll(() => state.uploads.length).toBe(1)
  state.disconnect()
  await expect.poll(() => state.sockets.length).toBe(sockets + 1)
  state.reconnect()
  await expect(page.locator('.terminal-toolbar')).toContainText('Connected')
  release()
  await expect(page.getByRole('alert')).toContainText('Image uploaded. Reconnect and retry')
  expect(state.inputs).toEqual([])
  await page.getByRole('button', { name: 'Retry image paste', exact: true }).click()
  await expect(page.locator('.terminal-image-paste')).toHaveCount(0)
  expect(state.uploads).toHaveLength(1)
  expect(state.inputs).toEqual([pasted])
  expect(state.errors).toEqual([])
})

test('a full terminal relaunch retains a failed image paste for explicit retry', async ({ page }) => {
  const state = await workspace(page, { backend: 'dtach' })
  state.onSubmit((socket, id) => socket.send(JSON.stringify({ type: 'input-result', id, accepted: false, message: 'Terminal input is busy' })))
  await imageEvent(page)
  await expect(page.getByRole('alert')).toContainText('Terminal input is busy')
  state.sockets.at(-1)!.send(JSON.stringify({ type: 'closed', message: 'Terminal closed. Relaunch to resume.' }))
  await expect(page.locator('.terminal-toolbar')).toContainText('Terminal closed')
  const connections = state.sockets.length
  await page.getByRole('button', { name: 'Relaunch', exact: true }).click()
  await expect.poll(() => state.sockets.length).toBe(connections + 1)
  await expect(page.locator('.terminal-toolbar')).toContainText('Connected')
  expect(state.uploads).toHaveLength(1)
  expect(state.inputs).toEqual([pasted])
  state.onSubmit((socket, id) => socket.send(JSON.stringify({ type: 'input-result', id, accepted: true })))
  await page.getByRole('button', { name: 'Retry image paste', exact: true }).click()
  await expect(page.locator('.terminal-image-paste')).toHaveCount(0)
  expect(state.uploads).toHaveLength(1)
  expect(state.inputs).toEqual([pasted, pasted])
  expect(state.errors).toEqual([])
})

test('rejected reference input is retryable without another upload; unsupported and oversized images never reach the target', async ({ page }) => {
  const state = await workspace(page, { backend: 'dtach' })
  state.onSubmit((socket, id) => socket.send(JSON.stringify({ type: 'input-result', id, accepted: false, message: 'Terminal input is busy' })))
  await imageEvent(page)
  await expect(page.getByRole('alert')).toContainText('Terminal input is busy')
  state.onSubmit((socket, id) => socket.send(JSON.stringify({ type: 'input-result', id, accepted: true })))
  await page.getByRole('button', { name: 'Retry image paste', exact: true }).click()
  await expect(page.locator('.terminal-image-paste')).toHaveCount(0)
  expect(state.uploads).toHaveLength(1)
  expect(state.inputs).toEqual([pasted, pasted])
  await imageEvent(page, 'image/svg+xml')
  await expect(page.getByRole('alert')).toContainText('not a PNG')
  await expect(page.getByRole('button', { name: 'Retry image paste', exact: true })).toHaveCount(0)
  await imageEvent(page, 'image/png', 16 * 1024 * 1024 + 1)
  await expect(page.getByRole('alert')).toContainText('16 MB')
  expect(state.uploads).toHaveLength(1)
  expect(state.inputs).toEqual([pasted, pasted])
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(page.locator('.terminal-image-paste')).toHaveCount(0)
  expect(state.errors).toEqual([])
})
