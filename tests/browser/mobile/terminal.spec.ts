import { test, expect, mockTerminal, viewport, fitsScreen } from './helpers'

test('portrait, narrow phone, landscape, and keyboard geometry keep controls accessible', async ({ page }, info) => {
  const terminal = await mockTerminal(page)
  const composer = page.getByRole('textbox', { name: 'Message to the session' })
  await expect(composer).toBeVisible()
  await fitsScreen(page)
  await page.screenshot({ path: info.outputPath('portrait.png') })
  for (const size of [
    { width: 320, height: 568 },
    { width: 844, height: 390 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size)
    await expect.poll(() => page.locator('.terminal-view').evaluate(e => e.clientHeight)).toBe(size.height)
    await fitsScreen(page)
  }
  for (const button of await page.locator('.terminal-actions button, .key-bar button').all()) {
    const bounds = await button.boundingBox()
    expect(bounds!.width).toBeGreaterThanOrEqual(44)
    expect(bounds!.height).toBeGreaterThanOrEqual(44)
  }
  expect(await composer.evaluate(e => getComputedStyle(e).fontSize)).toBe('16px')
  expect(
    await page
      .getByRole('textbox', { name: 'Terminal input', exact: true })
      .evaluate(e => getComputedStyle(e).fontSize),
  ).toBe('16px')
  await composer.fill('Line one\n你好 📱\nLine three')
  await composer.tap()
  const fullSize = terminal.messages.filter(message => message.type === 'resize').at(-1)!
  // OS keyboards cannot be opened in headless browsers. Reproduce the actual VisualViewport events.
  await viewport(page, { width: 390, height: 360, offsetTop: 28 })
  await expect.poll(() => page.locator('.terminal-view').evaluate(e => e.clientHeight)).toBe(360)
  await fitsScreen(page)
  await expect.poll(() => terminal.messages.filter(message => message.type === 'resize').at(-1)).not.toEqual(fullSize)
  await page.screenshot({ path: info.outputPath('keyboard.png') })
  await page.getByRole('button', { name: 'Select text', exact: true }).tap()
  const selection = page.getByRole('dialog', { name: 'Select text', exact: true })
  await expect(selection).toBeVisible()
  const selectionBounds = (await selection.boundingBox())!
  expect(selectionBounds.y).toBeGreaterThanOrEqual(28)
  expect(selectionBounds.y + selectionBounds.height).toBeLessThanOrEqual(388)
  await selection.getByRole('button', { name: 'Done' }).tap()
  const resized = terminal.messages.filter(message => message.type === 'resize').length
  const geometry = await page.locator('.terminal-view').boundingBox()
  await viewport(page, { scale: 2, width: 195, height: 180, offsetTop: 50 })
  await expect(page.locator('.terminal-view')).toHaveCSS('width', '390px')
  expect(await page.locator('.terminal-view').boundingBox()).toEqual(geometry)
  await expect(page.locator('.terminal-surface')).toHaveCSS('touch-action', 'auto')
  expect(terminal.messages.filter(message => message.type === 'resize')).toHaveLength(resized)
  await viewport(page, { scale: 1, width: 390, height: 844, offsetTop: 0 })
  await expect.poll(() => page.locator('.terminal-view').evaluate(e => e.clientHeight)).toBe(844)
  await expect(composer).toHaveValue('Line one\n你好 📱\nLine three')
  await fitsScreen(page)
})

test('touch Send keeps focus, sends Unicode once, and preserves edits made during acknowledgement', async ({
  page,
}) => {
  const terminal = await mockTerminal(page, { acknowledgeSends: false })
  terminal.output('\x1b[?2004h')
  const field = page.getByRole('textbox', { name: 'Message to the session' })
  const send = page.getByRole('button', { name: 'Send', exact: true })
  await field.fill('First line\n你好 👩🏽‍💻 café')
  await send.tap()
  await expect(field).toBeFocused()
  await expect(send).toBeDisabled()
  await expect(field).toBeEditable()
  await expect.poll(() => terminal.messages.filter(m => m.type === 'send').length).toBe(1)
  const submitted = terminal.messages.find(m => m.type === 'send')!
  expect(submitted.data).toBe('\x1b[200~First line\r你好 👩🏽‍💻 café\x1b[201~\r')
  await field.fill('Next draft while sending')
  terminal.send({ type: 'result', id: submitted.id, ok: true })
  await expect(send).toBeEnabled()
  await expect(field).toHaveValue('Next draft while sending')
  await send.tap()
  await expect.poll(() => terminal.messages.filter(m => m.type === 'send').length).toBe(2)
  const failed = terminal.messages.filter(m => m.type === 'send').at(-1)!
  terminal.send({ type: 'result', id: failed.id, ok: false, message: 'Delivery failed' })
  await expect(page.getByRole('alert')).toHaveText('Delivery failed')
  await expect(field).toHaveValue('Next draft while sending')
  await send.tap()
  await expect.poll(() => terminal.messages.filter(m => m.type === 'send').length).toBe(3)
  const last = terminal.messages.filter(m => m.type === 'send').at(-1)!
  terminal.send({ type: 'result', id: last.id, ok: true })
  await expect(field).toHaveValue('')
  await expect(field).toBeFocused()
})

test('IME composition never submits early and keyboard controls preserve one-shot modifiers', async ({ page }) => {
  const terminal = await mockTerminal(page)
  const field = page.getByRole('textbox', { name: 'Message to the session' })
  await field.fill('正在输入')
  await field.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true })
  expect(terminal.messages.filter(m => m.type === 'send')).toHaveLength(0)
  await expect(field).toHaveValue('正在输入')
  await field.press('Control+Enter')
  await expect(field).toHaveValue('')
  const keyboard = page.getByRole('button', { name: 'Keyboard', exact: true })
  await keyboard.tap()
  await expect(field).not.toBeFocused()
  await keyboard.tap()
  await expect(page.getByRole('textbox', { name: 'Terminal input', exact: true })).toBeFocused()
  const ctrl = page.getByRole('button', { name: 'Ctrl', exact: true })
  await ctrl.tap()
  await expect(ctrl).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('textbox', { name: 'Terminal input', exact: true }).press('c')
  await expect(ctrl).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: 'Escape', exact: true }).tap()
  await expect.poll(() => Buffer.concat(terminal.input).toString()).toBe('\x03\x1b')
})

test('text selection is a snapshot, supports wrapped Unicode, and does not stop live output', async ({
  page,
}, info) => {
  const terminal = await mockTerminal(page)
  const text = 'COPY START 你好 😀 ' + 'wrapped words '.repeat(7) + '\r\nSECOND LINE'
  terminal.output('\x1b[2J\x1b[H' + text)
  await expect(page.locator('.xterm-rows')).toContainText('SECOND LINE')
  await page.getByRole('button', { name: 'Select text', exact: true }).tap()
  const dialog = page.getByRole('dialog', { name: 'Select text', exact: true })
  const field = dialog.getByRole('textbox', { name: 'Terminal text' })
  const snapshot = (await field.inputValue()).trimEnd()
  expect(snapshot).toBe(text.replace('\r\n', '\n').trimEnd())
  await expect(field).toHaveAttribute('readonly', '')
  terminal.output('\r\nLIVE_AFTER_SELECTION')
  await expect(page.locator('.xterm-rows')).toContainText('LIVE_AFTER_SELECTION')
  await expect(field).not.toHaveValue(/LIVE_AFTER_SELECTION/)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          sessionStorage.setItem('copied', text)
        },
      },
    })
  })
  await field.evaluate((element: HTMLTextAreaElement) => {
    element.focus()
    element.setSelectionRange(0, 10)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await dialog.getByRole('button', { name: 'Copy selection' }).tap()
  await expect(dialog.getByRole('status')).toHaveText('Copied')
  expect(await page.evaluate(() => sessionStorage.getItem('copied'))).toBe(snapshot.slice(0, 10))
  await page.screenshot({ path: info.outputPath('select-text.png') })
  expect(Buffer.concat(terminal.input).length).toBe(0)
  await dialog.getByRole('button', { name: 'Done' }).tap()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('textbox', { name: 'Terminal input', exact: true })).not.toBeFocused()
})

test('clipboard denial offers mobile paste and copy fallback without losing the draft', async ({ page }) => {
  await mockTerminal(page)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => {
          throw new Error('Clipboard denied')
        },
        writeText: async () => {
          throw new Error('Clipboard denied')
        },
      },
    })
  })
  const field = page.getByRole('textbox', { name: 'Message to the session' })
  await field.fill('Keep this draft')
  await page.getByRole('button', { name: 'Message box', exact: true }).tap()
  await expect(field).toBeHidden()
  await page.getByRole('button', { name: 'Paste', exact: true }).tap()
  await expect(field).toBeVisible()
  await expect(field).toHaveValue('Keep this draft')
  await expect(page.locator('.terminal-notice')).toContainText('Touch and hold the message box')
  await page.getByRole('button', { name: 'Copy', exact: true }).tap()
  const dialog = page.getByRole('dialog', { name: 'Select text', exact: true })
  await dialog.getByRole('button', { name: 'Copy all' }).tap()
  await expect(dialog.getByRole('status')).toContainText('use Copy from its context menu')
})

test('returning to a healthy terminal probes once; a stale connection reconnects without replaying a draft', async ({
  page,
}) => {
  await page.clock.install()
  const terminal = await mockTerminal(page, { acknowledgeSends: false })
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')))
  await expect.poll(() => terminal.messages.filter(m => m.type === 'ping').length).toBe(1)
  expect(terminal.sockets).toHaveLength(1)
  terminal.state.answerPings = false
  const field = page.getByRole('textbox', { name: 'Message to the session' })
  await field.fill('Do not replay this')
  await page.getByRole('button', { name: 'Send', exact: true }).tap()
  await expect.poll(() => terminal.messages.filter(m => m.type === 'send').length).toBe(1)
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('pageshow'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => terminal.messages.filter(m => m.type === 'ping').length).toBe(2)
  await page.clock.fastForward(8100)
  await expect.poll(() => terminal.sockets.length).toBe(2)
  await expect(page.getByRole('status', { name: 'Connected', exact: true })).toBeVisible()
  await expect(field).toHaveValue('Do not replay this')
  await expect(page.getByRole('alert')).toContainText('Check the terminal before retrying')
  expect(terminal.messages.filter(m => m.type === 'send')).toHaveLength(1)
  expect(Buffer.concat(terminal.input).length).toBe(0)
  terminal.send({ type: 'closed', reason: 'ended', message: 'Session finished' })
  terminal.sockets.at(-1)!.close()
  await expect(page.getByRole('heading', { name: 'Session ended' })).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await page.clock.fastForward(20_000)
  expect(terminal.sockets).toHaveLength(2)
})
