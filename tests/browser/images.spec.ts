import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { Session, Target } from '../../shared/model'
import type { UploadedImage } from '../../shared/images'
import { desktopTerminal, appConnection, showTerminalToolbar } from './terminal-fixture'

const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 32, 10])

async function openSession(page: Page, mode: 'web' | 'desktop') {
  const headers = { 'x-outpost-request': '1' }
  const id = randomUUID()
  const targetResponse = await page.request.post('/api/targets', {
    headers,
    data: { kind: 'local', name: `Image target ${id}`, tools: ['claude'] },
  })
  expect(targetResponse.status()).toBe(201)
  const target: Target = await targetResponse.json()
  const response = await page.request.post(`/api/targets/${target.id}/sessions`, {
    headers,
    data: { name: `Images ${id}`, rootDir: `~/images-${id}`, tool: 'claude', createDirectory: true },
  })
  expect(response.status()).toBe(201)
  const session: Session = await response.json()
  await writeFile(join(session.rootDir, 'capture-input'), '')
  if (mode === 'desktop') {
    const connection = await appConnection(page.request, target.id, session.id)
    await desktopTerminal(page, connection.token)
    await page.goto('/terminal/desktop')
    await showTerminalToolbar(page)
  } else await page.goto(`/terminal?target=${target.id}&session=${session.id}`)
  await expect(page.getByRole('status', { name: 'Connected', exact: true })).toBeVisible()
  await expect(page.locator('.xterm-rows')).toContainText('OUTPOST_FIXTURE_READY')
  return session
}

async function gesture(page: Page, kind: 'paste' | 'drop', files = [{ type: 'image/png', name: 'screen.png' }]) {
  return page.locator('.xterm').evaluate(
    (element, { kind, files, bytes }) => {
      const transfer = new DataTransfer()
      for (const file of files) transfer.items.add(new File([new Uint8Array(bytes)], file.name, { type: file.type }))
      const event =
        kind === 'paste'
          ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
          : new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
      element.dispatchEvent(event)
      return event.defaultPrevented
    },
    { kind, files, bytes: [...bytes] },
  )
}

for (const mode of ['web', 'desktop'] as const) {
  test(`${mode}: picker, clipboard paste and drop upload exact bytes and paste only one bracketed reference`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const session = await openSession(page, mode)
    const originalSize = await page.locator('.xterm-screen').boundingBox()
    const input = () => readFile(join(session.rootDir, 'input.bin'), 'utf8').catch(() => '')
    for (const kind of ['picker', 'paste', 'drop'] as const) {
      const before = await input()
      const response = page.waitForResponse(response => response.url().endsWith('/api/terminal/image'))
      if (kind === 'picker')
        await page
          .locator('input[type=file]')
          .setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: bytes })
      else expect(await gesture(page, kind)).toBe(true)
      const uploaded = await response
      expect(uploaded.status()).toBe(200)
      expect(uploaded.request().headers().authorization).toMatch(/^Bearer /)
      expect(uploaded.request().headers()['content-type']).toBe('image/png')
      const image: UploadedImage = await uploaded.json()
      expect(await readFile(image.path)).toEqual(bytes)
      await expect(page.getByRole('status').filter({ hasText: 'Image pasted' })).toBeVisible()
      await expect.poll(input).toBe(`${before}\x1b[200~${image.reference}\x1b[201~`)
      expect(await page.locator('.xterm-screen').boundingBox()).toEqual(originalSize)
    }
    expect(errors).toEqual([])
  })
}

test('invalid or multiple image drops are rejected without navigation or terminal input', async ({ page }) => {
  const session = await openSession(page, 'web')
  let uploads = 0
  page.on('request', request => {
    if (request.url().endsWith('/api/terminal/image')) uploads++
  })
  const url = page.url()
  expect(await gesture(page, 'drop', [{ name: 'document.txt', type: 'text/plain' }])).toBe(true)
  await expect(page.getByRole('status').filter({ hasText: 'That is not a PNG' })).toBeVisible()
  expect(
    await gesture(page, 'drop', [
      { name: 'a.png', type: 'image/png' },
      { name: 'b.png', type: 'image/png' },
    ]),
  ).toBe(true)
  await expect(page.getByRole('status').filter({ hasText: 'Drop one image at a time' })).toBeVisible()
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) })
  await expect(page.getByRole('status').filter({ hasText: 'Images must be between' })).toBeVisible()
  expect(uploads).toBe(0)
  expect(page.url()).toBe(url)
  expect(await readFile(join(session.rootDir, 'input.bin')).catch(() => Buffer.alloc(0))).toHaveLength(0)
})

test('upload progress leaves the viewport and live typing intact, and a second image is not queued', async ({
  page,
}) => {
  const session = await openSession(page, 'web')
  const size = await page.locator('.xterm-screen').boundingBox()
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let uploads = 0
  await page.route('**/api/terminal/image', async route => {
    uploads++
    await gate
    await route.continue()
  })
  try {
    await gesture(page, 'paste')
    await expect(page.getByRole('status').filter({ hasText: 'Uploading image' })).toBeVisible()
    expect(await page.locator('.xterm-screen').boundingBox()).toEqual(size)
    await page.getByRole('textbox', { name: 'Terminal input' }).pressSequentially('typing-during-upload')
    await expect
      .poll(() =>
        readFile(join(session.rootDir, 'input.bin'), 'utf8').catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
          throw error
        }),
      )
      .toBe('typing-during-upload')
    await gesture(page, 'drop')
    await expect(page.getByRole('status').filter({ hasText: 'An image is already' })).toBeVisible()
    expect(uploads).toBe(1)
  } finally {
    release()
  }
  await expect(page.getByRole('status').filter({ hasText: 'Image pasted' })).toBeVisible()
  expect(await page.locator('.xterm-screen').boundingBox()).toEqual(size)
  expect(uploads).toBe(1)
})
