import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from './fixtures'
import type { Session, Target } from '../../shared/model'

const bytes = readFileSync('public/favicon-32x32.png')

async function openSession(page: Page) {
  const headers = { 'x-outpost-request': '1' }
  const id = randomUUID()
  const targetResponse = await page.request.post('/api/targets', {
    headers,
    data: { kind: 'local', name: `Image target ${id}` },
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
  await page.goto(`/terminal?target=${target.id}&session=${session.id}`)
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

test(`Web terminal: picker, clipboard paste and drop deliver exact pixels through one native paste`, async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const session = await openSession(page)
  const originalSize = await page.locator('.xterm-screen').boundingBox()
  const input = () => readFile(join(session.rootDir, 'input.bin'), 'utf8').catch(() => '')
  for (const kind of ['picker', 'paste', 'drop'] as const) {
    const before = await input()
    if (kind === 'picker')
      await page.locator('input[type=file]').setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: bytes })
    else expect(await gesture(page, kind)).toBe(true)
    await expect.poll(async () => (await input()).slice(before.length)).toBe('\x16')
    await expect.poll(() => readFile(join(session.rootDir, 'clipboard.png')).catch(() => null)).toEqual(bytes)
    expect(await page.locator('.xterm-screen').boundingBox()).toEqual(originalSize)
  }
  expect(errors).toEqual([])
})

test('the explicit file path action inserts a readable path without pressing Enter', async ({ page }) => {
  const session = await openSession(page)
  await page.evaluate(
    pixels => {
      const blob = new Blob([new Uint8Array(pixels)], { type: 'image/png' })
      Object.defineProperty(navigator.clipboard, 'read', {
        value: async () => [new ClipboardItem({ 'image/png': blob })],
      })
    },
    [...bytes],
  )
  await page.locator('.xterm-screen').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Paste image as file path' }).click()
  const capture = () => readFile(join(session.rootDir, 'input.bin'), 'utf8').catch(() => '')
  await expect.poll(capture).toContain('.png')
  const inserted = (await capture()).replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '')
  expect(inserted).toMatch(/^\/[^\r\n]+\.png$/)
  expect(await readFile(inserted)).toEqual(bytes)
})

test('invalid or multiple image drops are rejected without navigation or terminal input', async ({ page }) => {
  let uploads = 0
  page.on('websocket', socket =>
    socket.on('framesent', ({ payload }) => {
      if (typeof payload === 'string' && JSON.parse(payload).type === 'image-write') uploads++
    }),
  )
  const session = await openSession(page)
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
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let uploads = 0
  await page.routeWebSocket(/\/api\/terminal\?/, socket => {
    const server = socket.connectToServer()
    socket.onMessage(async frame => {
      if (typeof frame === 'string' && JSON.parse(frame).type === 'image-write') {
        uploads++
        await gate
      }
      server.send(frame)
    })
  })
  const session = await openSession(page)
  const size = await page.locator('.xterm-screen').boundingBox()
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
  await expect(page.getByRole('status').filter({ hasText: 'Image attached' })).toBeVisible()
  expect(await page.locator('.xterm-screen').boundingBox()).toEqual(size)
  expect(uploads).toBe(1)
})
