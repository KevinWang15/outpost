import { test, expect, mockTerminal, viewport } from './helpers'
import type { Page } from '@playwright/test'

// Trusted Android touch input through CDP; WebKit uses DOM events for the gesture-routing contract.
async function swipe(page: Page, chromium: boolean, start: { x: number; y: number }, end: { x: number; y: number }) {
  if (chromium) {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] })
    for (let step = 1; step <= 8; step++)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          {
            x: start.x + ((end.x - start.x) * step) / 8,
            y: start.y + ((end.y - start.y) * step) / 8,
          },
        ],
      })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
  } else {
    await page.locator('.xterm-screen').evaluate(
      (element, { start, end }) => {
        const dispatch = (type: string, point: { x: number; y: number } | null) => {
          const touch = point ? { identifier: 1, target: element, clientX: point.x, clientY: point.y } : null
          // WebKit's headless port has no public touch-drag protocol. Match TouchEvent's readable shape.
          const event = new Event(type, { bubbles: true, cancelable: true })
          Object.defineProperty(event, 'touches', { value: touch ? [touch] : [] })
          element.dispatchEvent(event)
        }
        dispatch('touchstart', start)
        for (let step = 1; step <= 8; step++)
          dispatch('touchmove', {
            x: start.x + ((end.x - start.x) * step) / 8,
            y: start.y + ((end.y - start.y) * step) / 8,
          })
        dispatch('touchend', null)
      },
      { start, end },
    )
  }
}

test('vertical swipes reach app mouse tracking; horizontal and zoomed gestures do not type or scroll the app', async ({
  page,
  browserName,
}) => {
  const terminal = await mockTerminal(page)
  terminal.output('\x1b[?1049h\x1b[?1000h\x1b[?1006hMOUSE_READY')
  await expect(page.locator('.xterm-rows')).toContainText('MOUSE_READY')
  const surface = (await page.locator('.xterm-screen').boundingBox())!
  const start = { x: surface.x + 100, y: surface.y + 150 }
  const end = { x: start.x, y: start.y - 100 }
  const input = () => Buffer.concat(terminal.input).toString().replaceAll('\x1b', 'ESC')
  await swipe(page, browserName === 'chromium', start, end)
  await expect.poll(input).toMatch(/ESC\[<65;\d+;\d+M/)
  // No synthetic mouse press/release or arrow key is mixed into a scroll gesture.
  expect(input().replace(/ESC\[<65;\d+;\d+M/g, '')).toBe('')
  terminal.input.length = 0
  await swipe(page, browserName === 'chromium', start, { x: start.x + 80, y: start.y - 20 })
  expect(Buffer.concat(terminal.input).length).toBe(0)
  await viewport(page, { scale: 2 })
  await expect(page.locator('.terminal-surface')).toHaveCSS('touch-action', 'auto')
  await swipe(page, browserName === 'chromium', start, end)
  expect(Buffer.concat(terminal.input).length).toBe(0)
})

test('normal-buffer swipes browse local scrollback without sending terminal input', async ({ page, browserName }) => {
  const terminal = await mockTerminal(page)
  terminal.output(Array.from({ length: 180 }, (_, i) => `SCROLL_LINE_${String(i).padStart(3, '0')}\r\n`).join(''))
  await expect(page.locator('.xterm-rows')).toContainText('SCROLL_LINE_179')
  const surface = (await page.locator('.xterm-screen').boundingBox())!
  const start = { x: surface.x + 80, y: surface.y + 100 }
  await swipe(page, browserName === 'chromium', start, { x: start.x, y: start.y + 180 })
  await expect(page.locator('.xterm-rows')).not.toContainText('SCROLL_LINE_179')
  expect(Buffer.concat(terminal.input).length).toBe(0)
  // Selecting a snapshot must not send mouse input or reset the viewport to live output.
  const before = await page.locator('.xterm-rows').innerText()
  await page.getByRole('button', { name: 'Select text', exact: true }).tap()
  await page.getByRole('dialog', { name: 'Select text', exact: true }).getByRole('button', { name: 'Done' }).tap()
  expect(await page.locator('.xterm-rows').innerText()).toBe(before)
  expect(Buffer.concat(terminal.input).length).toBe(0)
})

test('multi-touch cancels terminal scrolling and a long press opens the shared text menu', async ({ page }) => {
  const terminal = await mockTerminal(page)
  terminal.output('\x1b[?1049h\x1b[?1000h\x1b[?1006hPINCH_READY')
  await expect(page.locator('.xterm-rows')).toContainText('PINCH_READY')
  await page.locator('.xterm-screen').evaluate(element => {
    const dispatch = (type: string, points: { identifier: number; clientX: number; clientY: number }[]) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'touches', { value: points })
      element.dispatchEvent(event)
    }
    dispatch('touchstart', [{ identifier: 1, clientX: 100, clientY: 200 }])
    dispatch('touchstart', [
      { identifier: 1, clientX: 100, clientY: 200 },
      { identifier: 2, clientX: 200, clientY: 200 },
    ])
    dispatch('touchmove', [
      { identifier: 1, clientX: 80, clientY: 150 },
      { identifier: 2, clientX: 220, clientY: 250 },
    ])
    dispatch('touchend', [{ identifier: 1, clientX: 80, clientY: 150 }])
    dispatch('touchmove', [{ identifier: 1, clientX: 80, clientY: 100 }])
    dispatch('touchend', [])
  })
  expect(Buffer.concat(terminal.input).length).toBe(0)
  await page.clock.install()
  await page
    .locator('.terminal-surface')
    .dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 80, clientY: 120, button: 0 })
  await page.clock.fastForward(800)
  await expect(page.getByRole('menu')).toBeVisible()
  await page.getByRole('menuitem', { name: 'Select text…', exact: true }).tap()
  await expect(page.getByRole('textbox', { name: 'Terminal text' })).toHaveValue(/PINCH_READY/)
  await expect(page.getByRole('textbox', { name: 'Terminal input', exact: true })).not.toBeFocused()
})
