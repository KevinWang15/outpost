import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

test.use({ hasTouch: true })

test('Ctrl+/ reaches the coding process once, from the keyboard and the on-screen Ctrl key', async ({ page }) => {
  const sent: Buffer[] = []
  page.on('websocket', socket =>
    socket.on('framesent', ({ payload }) => {
      if (Buffer.isBuffer(payload)) sent.push(payload)
    }),
  )
  const headers = { 'x-outpost-request': '1' }
  const targetResponse = await page.request.post('/api/targets', {
    headers,
    data: { kind: 'local', name: 'Keyboard box', tools: ['claude'] },
  })
  expect(targetResponse.status()).toBe(201)
  const target = await targetResponse.json()
  const sessionResponse = await page.request.post(`/api/targets/${target.id}/sessions`, {
    headers,
    data: { name: 'Keyboard session', rootDir: '~/keyboard-project', tool: 'claude', createDirectory: true },
  })
  expect(sessionResponse.status()).toBe(201)
  const session = await sessionResponse.json()
  await writeFile(join(session.rootDir, 'capture-input'), '')
  await page.goto(`/terminal?target=${target.id}&session=${session.id}`)
  await expect(page.locator('.xterm-rows')).toContainText('OUTPOST_FIXTURE_READY')
  const input = page.getByRole('textbox', { name: 'Terminal input' })
  const path = join(session.rootDir, 'input.bin')
  const begin = 'KEYS_BEGIN'
  await input.pressSequentially(begin)
  await expect.poll(async () => (await readFile(path, 'latin1').catch(() => '')).includes(begin)).toBe(true)
  const received = async () => (await readFile(path, 'latin1')).split(begin)[1]
  let expected = ''
  for (const [key, bytes] of [
    ['Control+Slash', '\x1f'],
    ['Control+Shift+Minus', '\x1f'],
    ['Control+7', '\x1f'],
    ['Control+c', '\x03'],
    ['Slash', '/'],
    ['Shift+Slash', '?'],
  ]) {
    await input.press(key)
    await input.pressSequentially('|')
    expected += bytes + '|'
    await expect.poll(received, { message: `${key} must reach the process exactly once` }).toBe(expected)
  }
  const ctrl = page.getByRole('button', { name: 'Ctrl', exact: true })
  await ctrl.click()
  await input.press('Slash')
  await expect(ctrl).toHaveAttribute('aria-pressed', 'false')
  await input.press('Slash')
  await input.pressSequentially('|')
  await expect.poll(received).toBe(expected + '\x1f/|')

  // Modified Enter uses a negotiated protocol. Check the browser encoding
  // independently of the fixture's tmux startup negotiation.
  sent.length = 0
  await input.press('Shift+Enter')
  await expect.poll(() => Buffer.concat(sent).toString('latin1')).toBe('\x1b[13;2u')
})
