import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'

declare global {
  interface Window {
    bellAudio: { contexts: AudioContext[]; sounds: number }
  }
}

async function openTerminal(page: Page) {
  await page.route('**/api/targets/bell-target/sessions/bell-session/connect', route =>
    route.fulfill({ json: { token: 'bell-test' } }),
  )
  let socket!: WebSocketRoute
  await page.routeWebSocket(/\/api\/terminal\?/, ws => {
    socket = ws
    ws.send(
      JSON.stringify({
        type: 'hello',
        resume: 'bell-resume',
        session: { id: 'bell-session', name: 'Coding session' },
        target: { id: 'bell-target', name: 'Dev box' },
      }),
    )
    ws.send(JSON.stringify({ type: 'ready' }))
  })
  await page.goto('/terminal?target=bell-target&session=bell-session')
  await expect(page.getByText('Connected', { exact: true })).toBeVisible()
  await expect(page).toHaveTitle('Coding session · Dev box · Outpost')
  return socket
}

// Headless pages do not consistently model OS window focus or tab visibility.
async function attention(page: Page, focused: boolean, visible = focused) {
  await page.evaluate(
    ({ focused, visible }) => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused })
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: visible ? 'visible' : 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event(focused ? 'focus' : 'blur'))
    },
    { focused, visible },
  )
}

test('bells mark the page, chime once per burst, and clear when acknowledged', async ({ page }) => {
  await page.addInitScript(() => {
    window.bellAudio = { contexts: [], sounds: 0 }
    const BrowserAudioContext = window.AudioContext
    window.AudioContext = class extends BrowserAudioContext {
      constructor() {
        super()
        window.bellAudio.contexts.push(this)
      }
    }
    const start = OscillatorNode.prototype.start
    OscillatorNode.prototype.start = function (when) {
      window.bellAudio.sounds++
      start.call(this, when)
    }
  })
  await page.clock.install()
  const socket = await openTerminal(page)
  const input = page.getByRole('textbox', { name: 'Terminal input' })
  const notice = page.getByRole('status').filter({ hasText: 'rang a bell' })
  const surface = page.locator('.terminal-surface')
  const dimensions = await surface.boundingBox()
  await input.press('ArrowRight')
  await expect.poll(() => page.evaluate(() => window.bellAudio.contexts[0]?.state)).toBe('running')
  await attention(page, false)
  socket.send(Buffer.from('\x07\x07\x07'))
  await expect(page).toHaveTitle('🔔 Coding session · Dev box rang a bell · Outpost')
  await expect(notice).toHaveText('Coding session · Dev box rang a bell')
  expect(await surface.boundingBox()).toEqual(dimensions)
  expect(await page.evaluate(() => window.bellAudio.sounds)).toBe(1)
  await page.clock.fastForward(10_000)
  await expect(page).toHaveTitle(/rang a bell/)

  // A visible window still needs attention if another app has focus.
  await attention(page, false, true)
  await expect(page).toHaveTitle(/rang a bell/)
  await attention(page, true)
  await expect(page).toHaveTitle('Coding session · Dev box · Outpost')
  await expect(notice).toBeHidden()

  socket.send(Buffer.from('\x07'))
  await expect(notice).toContainText('rang a bell')
  expect(await page.evaluate(() => window.bellAudio.sounds)).toBe(2)
  await page.clock.fastForward(4000)
  await expect(page).toHaveTitle('Coding session · Dev box · Outpost')

  // Suspended audio must not queue old bells to play on the next gesture.
  await page.evaluate(() => window.bellAudio.contexts[0].suspend())
  socket.send(Buffer.from('\x07'))
  await expect(page).toHaveTitle(/rang a bell/)
  await input.press('ArrowRight')
  await expect(page).toHaveTitle('Coding session · Dev box · Outpost')
  await expect.poll(() => page.evaluate(() => window.bellAudio.contexts[0].state)).toBe('running')
  expect(await page.evaluate(() => window.bellAudio.sounds)).toBe(2)
})

test('OSC terminators do not ring, and visual bells work without audio', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    Object.defineProperty(window, 'AudioContext', {
      value: class {
        constructor() {
          throw new Error('Audio unavailable')
        }
      },
    })
  })
  const socket = await openTerminal(page)
  socket.send(Buffer.from('\x1b]0;Remote title\x07\x1b]52;c;Y29weQ==\x07NO_BELL\r\n'))
  await expect(page.locator('.xterm-rows')).toContainText('NO_BELL')
  await expect(page).toHaveTitle('Coding session · Dev box · Outpost')
  await expect(page.getByText('Coding session · Dev box rang a bell')).toBeHidden()

  socket.send(Buffer.from('\x07STILL_CONNECTED\r\n'))
  await expect(page).toHaveTitle(/rang a bell/)
  await expect(page.locator('.xterm-rows')).toContainText('STILL_CONNECTED')
  await page.getByRole('button', { name: 'Dismiss bell notification' }).click()
  await expect(page).toHaveTitle('Coding session · Dev box · Outpost')
  expect(errors).toEqual([])
})
