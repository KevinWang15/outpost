import { expect, test, type Page } from '@playwright/test'
import { webTerminalWorkspace as workspace } from './web-terminal-fixture'

const bracket = (text: string) => `\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`
const osc52 = (text: string) => `\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`
type Workspace = Awaited<ReturnType<typeof workspace>>

async function output(state: Workspace, data: string) {
  const count = state.acknowledgements.length
  state.sockets.at(-1)!.send(Buffer.from(data))
  await expect.poll(() => state.acknowledgements.length).toBeGreaterThan(count)
}

async function selectWord(page: Page) {
  const screen = (await page.locator('.xterm-screen').boundingBox())!
  await page.mouse.dblclick(screen.x + 25, screen.y + 8)
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeEnabled()
}

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
})

test('native paste shortcuts send local text once, preserve bracketed paste, and bypass the armed Ctrl key', async ({ page }) => {
  const state = await workspace(page)
  const input = page.getByLabel('Terminal input', { exact: true })
  const text = 'Local clipboard 漢字 🐚\nsecond line'
  await page.evaluate(text => navigator.clipboard.writeText(text), text)
  for (const [index, shortcut] of ['Control+v', 'Control+Shift+v', 'Shift+Insert'].entries()) {
    await input.press(shortcut)
    await expect.poll(() => state.inputs).toEqual(Array.from({ length: index + 1 }, () => bracket(text)))
  }
  await output(state, '\x1b[?2004l')
  await page.evaluate(() => navigator.clipboard.writeText('a'))
  await page.getByRole('button', { name: 'Ctrl', exact: true }).click()
  await input.press('Control+v')
  await expect.poll(() => state.inputs.at(-1)).toBe('a')
  await expect(page.getByRole('button', { name: 'Ctrl', exact: true })).toHaveAttribute('aria-pressed', 'false')
  expect(state.inputs).toHaveLength(4)
  expect(state.errors).toEqual([])
})

test('selection copy shortcuts and Copy use the local clipboard; Ctrl+C without selection still interrupts', async ({ page }) => {
  const state = await workspace(page)
  const input = page.getByLabel('Terminal input', { exact: true })
  await selectWord(page)
  for (const shortcut of ['Control+c', 'Control+Shift+c']) {
    await page.evaluate(() => navigator.clipboard.writeText('unchanged'))
    await input.press(shortcut)
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Composer')
    expect(state.inputs).toEqual([])
  }
  await page.evaluate(() => navigator.clipboard.writeText('unchanged'))
  await page.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Composer')
  await page.getByRole('button', { name: 'Ctrl+C', exact: true }).click()
  await expect.poll(() => state.inputs).toEqual(['\x03'])
  const screen = (await page.locator('.xterm-screen').boundingBox())!
  await page.mouse.click(screen.x + 25, screen.y + 35)
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeDisabled()
  await input.press('Control+c')
  await expect.poll(() => state.inputs).toEqual(['\x03', '\x03'])
  await input.press('Control+Shift+c')
  await expect(page.locator('.terminal-clipboard-status')).toHaveText('Select text in the terminal to copy.')
  expect(state.inputs).toHaveLength(2)
  expect(state.errors).toEqual([])
})

test('Paste uses the local clipboard and gives a native-shortcut fallback when API access is blocked', async ({ page }) => {
  const state = await workspace(page)
  await page.evaluate(() => navigator.clipboard.writeText('local button paste'))
  await page.getByRole('button', { name: 'Paste', exact: true }).click()
  await expect.poll(() => state.inputs).toEqual([bracket('local button paste')])
  await page.evaluate(() => { navigator.clipboard.readText = async () => { throw new DOMException('Blocked', 'NotAllowedError') } })
  await page.getByRole('button', { name: 'Paste', exact: true }).click()
  await expect(page.locator('.terminal-clipboard-status')).toContainText('Use your paste shortcut')
  await page.getByLabel('Terminal input', { exact: true }).press('Control+v')
  await expect.poll(() => state.inputs).toEqual([bracket('local button paste'), bracket('local button paste')])
  await expect(page.locator('.terminal-clipboard-status')).toHaveCount(0)
  await page.evaluate(() => navigator.clipboard.writeText('漢'.repeat(6000)))
  await page.getByLabel('Terminal input', { exact: true }).press('Control+v')
  await expect(page.locator('.terminal-toolbar')).toContainText('16 KiB')
  expect(state.inputs).toHaveLength(2)
  expect(state.errors).toEqual([])
})

test('remote OSC 52 copies Unicode locally, accepts both terminators, and never answers clipboard queries', async ({ page }) => {
  const state = await workspace(page)
  const text = 'Remote selection 漢字 🐚\nsecond line'
  await output(state, osc52(text))
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text)
  await output(state, `\x1b]52;;${Buffer.from('ST terminated').toString('base64')}\x1b\\`)
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('ST terminated')
  await page.evaluate(() => {
    document.body.dataset.clipboardReads = '0'
    navigator.clipboard.readText = async () => { document.body.dataset.clipboardReads = '1'; return 'private local content' }
    navigator.clipboard.writeText = async () => { document.body.dataset.unexpectedCopy = 'true' }
  })
  await output(state, '\x1b]52;c;?\x07\x1b]52;c;invalid!\x07')
  await output(state, osc52('a'.repeat(1024 * 1024 + 1)))
  expect(await page.evaluate(() => document.body.dataset.clipboardReads)).toBe('0')
  expect(await page.evaluate(() => document.body.dataset.unexpectedCopy)).toBeUndefined()
  expect(state.inputs).toEqual([])
  await expect(page.locator('.terminal-toolbar')).toContainText('Connected')
  expect(state.errors).toEqual([])
})

test('a remote copy blocked by the browser can be completed with the Copy button', async ({ page }) => {
  const state = await workspace(page)
  await selectWord(page)
  await page.evaluate(() => {
    const writeText = navigator.clipboard.writeText.bind(navigator.clipboard)
    let first = true
    navigator.clipboard.writeText = async text => {
      if (first) { first = false; throw new DOMException('User gesture required', 'NotAllowedError') }
      await writeText(text)
    }
  })
  await output(state, osc52('Remote text to copy'))
  await expect(page.locator('.terminal-clipboard-status')).toContainText('Remote text is ready. Click Copy')
  await page.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Remote text to copy')
  await expect(page.locator('.terminal-clipboard-status')).toHaveText('Copied to your clipboard.')
  expect(state.inputs).toEqual([])
  expect(state.errors).toEqual([])
})

test('an asynchronous paste cannot cross a disconnected connection', async ({ page }) => {
  const state = await workspace(page)
  await page.evaluate(() => {
    navigator.clipboard.readText = () => new Promise(resolve => {
      document.body.dataset.pastePending = 'true'
      document.addEventListener('resolve-test-paste', () => resolve('stale paste'), { once: true })
    })
  })
  await page.getByRole('button', { name: 'Paste', exact: true }).click()
  expect(await page.evaluate(() => document.body.dataset.pastePending)).toBe('true')
  const count = state.sockets.length
  state.disconnect()
  await expect(page.getByRole('button', { name: 'Paste', exact: true })).toBeDisabled()
  await expect.poll(() => state.sockets.length).toBe(count + 1)
  state.reconnect()
  await expect(page.locator('.terminal-toolbar')).toContainText('Connected')
  await page.evaluate(() => document.dispatchEvent(new Event('resolve-test-paste')))
  await page.getByLabel('Terminal input', { exact: true }).press('x')
  await expect.poll(() => state.inputs).toEqual(['x'])
  expect(state.errors).toEqual([])
})

test('screen snapshots cannot replay remote copy requests', async ({ page }) => {
  const state = await workspace(page)
  await page.evaluate(() => navigator.clipboard.writeText('keep local text'))
  const count = state.acknowledgements.length
  state.sockets.at(-1)!.send(JSON.stringify({ type: 'snapshot', cols: 80, rows: 24, data: osc52('old remote clipboard') + 'Restored screen' }))
  await expect.poll(() => state.acknowledgements.length).toBeGreaterThan(count)
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('keep local text')
  await output(state, osc52('new remote clipboard'))
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('new remote clipboard')
  expect(state.errors).toEqual([])
})

test.describe('phone clipboard', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  test('Copy and Paste stay usable with a remote-copy prompt and a small viewport', async ({ page }) => {
    const state = await workspace(page, { hosted: true })
    await page.getByRole('button', { name: 'Fullscreen', exact: true }).tap()
    await page.setViewportSize({ width: 360, height: 300 })
    await page.evaluate(() => {
      const writeText = navigator.clipboard.writeText.bind(navigator.clipboard)
      navigator.clipboard.writeText = async text => {
        navigator.clipboard.writeText = writeText
        throw new DOMException(`Gesture required for ${text.length} characters`, 'NotAllowedError')
      }
    })
    await output(state, osc52('Remote text from phone'))
    await expect(page.locator('.terminal-clipboard-status')).toContainText('Click Copy')
    await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport({ ratio: 1 })
    await page.getByRole('button', { name: 'Copy', exact: true }).tap()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Remote text from phone')
    await page.getByRole('button', { name: 'Paste', exact: true }).tap()
    await expect.poll(() => state.inputs).toEqual([bracket('Remote text from phone')])
    expect((await page.locator('.terminal-surface').boundingBox())!.height).toBeGreaterThan(40)
    expect(state.errors).toEqual([])
  })
})
