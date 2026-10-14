import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'

declare global {
  interface Window {
    bellAudio: { contexts: AudioContext[]; sounds: number }
    bellNotifications: {
      permission: NotificationPermission
      result: NotificationPermission | 'error'
      requests: number
      gestures: boolean[]
      focused: number
      failConstruction: boolean
      instances: {
        title: string
        options: NotificationOptions
        closed: boolean
        onclick: ((event: Event) => void) | null
        onclose: ((event: Event) => void) | null
        onerror: ((event: Event) => void) | null
        close: () => void
      }[]
    }
  }
}

async function mockNotifications(page: Page, permission: NotificationPermission = 'default') {
  await page.context().addInitScript(permission => {
    window.bellNotifications = {
      permission,
      result: 'granted',
      requests: 0,
      gestures: [],
      focused: 0,
      failConstruction: false,
      instances: [],
    }
    // Browser permission is shared across same-origin tabs in this profile.
    const permissionKey = 'outpost-test-notification-permission'
    Object.defineProperty(window.bellNotifications, 'permission', {
      get: () => localStorage.getItem(permissionKey) ?? permission,
      set: value => localStorage.setItem(permissionKey, value),
    })
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: class {
        static get permission() {
          return window.bellNotifications.permission
        }
        static async requestPermission() {
          const state = window.bellNotifications
          state.requests++
          state.gestures.push(navigator.userActivation.isActive)
          if (state.result === 'error') throw new Error('Permission request failed')
          return (state.permission = state.result)
        }
        onclick: ((event: Event) => void) | null = null
        onclose: ((event: Event) => void) | null = null
        onerror: ((event: Event) => void) | null = null
        closed = false
        constructor(
          public title: string,
          public options: NotificationOptions = {},
        ) {
          if (window.bellNotifications.failConstruction) throw new Error('Notification unavailable')
          window.bellNotifications.instances.push(this)
        }
        close() {
          this.closed = true
          this.onclose?.(new Event('close'))
        }
      },
    })
    window.focus = () => window.bellNotifications.focused++
  }, permission)
}

async function openTerminal(page: Page, mode: 'web' | 'desktop' = 'web') {
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
  await page.goto(
    mode === 'web' ? '/terminal?target=bell-target&session=bell-session' : '/terminal/desktop#token=bell.launch',
  )
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

for (const mode of ['web', 'desktop'] as const) {
  test(`desktop bells (${mode}) request permission on click, group alerts, and return to the correct session`, async ({
    page,
  }) => {
    await mockNotifications(page)
    await page.clock.install()
    const socket = await openTerminal(page, mode)
    const alerts = () => page.evaluate(() => window.bellNotifications.instances.length)
    const notice = page.getByRole('status').filter({ hasText: 'rang a bell' })
    const input = page.getByRole('textbox', { name: 'Terminal input' })
    await attention(page, false)
    socket.send(Buffer.from('\x07'))
    await expect(notice).toBeVisible()
    expect(await alerts()).toBe(0)
    expect(await page.evaluate(() => window.bellNotifications.requests)).toBe(0)

    await attention(page, true)
    await page.getByRole('button', { name: 'Enable desktop notifications', exact: true }).click()
    expect(await page.evaluate(() => window.bellNotifications.requests)).toBe(1)
    expect(await page.evaluate(() => window.bellNotifications.gestures)).toEqual([true])
    await expect(page.getByRole('button', { name: 'Desktop notifications enabled', exact: true })).toBeVisible()
    socket.send(Buffer.from('\x07'))
    await expect(notice).toBeVisible()
    expect(await alerts()).toBe(0)

    // A visible terminal still needs a desktop alert when another app has focus.
    await attention(page, false, true)
    socket.send(Buffer.from('\x07\x07\x07'))
    await expect.poll(alerts).toBe(1)
    expect(
      await page.evaluate(() => {
        const { title, options } = window.bellNotifications.instances[0]
        return { title, options }
      }),
    ).toEqual({
      title: 'Outpost · Terminal bell',
      options: {
        body: 'Coding session · Dev box rang a bell',
        icon: '/outpost.png',
        tag: 'outpost-bell:bell-target/bell-session',
      },
    })
    await page.clock.fastForward(10_000)
    socket.send(Buffer.from('\x07'))
    await expect(notice).toBeVisible()
    expect(await alerts()).toBe(1)

    await page.evaluate(() => window.bellNotifications.instances[0].onclick?.(new Event('click')))
    await expect(notice).toBeHidden()
    await expect(input).toBeFocused()
    expect(await page.evaluate(() => window.bellNotifications.focused)).toBe(1)
    expect(await page.evaluate(() => window.bellNotifications.instances[0].closed)).toBe(true)

    // Use the latest session name, including a hello received after a reconnect.
    socket.send(
      JSON.stringify({
        type: 'hello',
        resume: 'bell-resume',
        session: { id: 'bell-session', name: 'Renamed session' },
        target: { id: 'bell-target', name: 'Dev box' },
      }),
    )
    await expect(page).toHaveTitle('Renamed session · Dev box · Outpost')
    await attention(page, false)
    socket.send(Buffer.from('\x07'))
    await expect.poll(alerts).toBe(2)
    expect(await page.evaluate(() => window.bellNotifications.instances[1].options.body)).toBe(
      'Renamed session · Dev box rang a bell',
    )
    // Dismissing an OS banner does not make subsequent output flood the desktop.
    await page.evaluate(() => window.bellNotifications.instances[1].close())
    socket.send(Buffer.from('\x07'))
    await expect(notice).toBeVisible()
    expect(await alerts()).toBe(2)
    await attention(page, true)
    await expect(notice).toBeHidden()

    await attention(page, false)
    socket.send(Buffer.from('\x07'))
    await expect.poll(alerts).toBe(3)
    await attention(page, true)
    await expect(notice).toBeHidden()
    expect(await page.evaluate(() => window.bellNotifications.instances[2].closed)).toBe(true)
  })
}

test('saved notification permission is used and revoking it stops desktop bells', async ({ page }) => {
  await mockNotifications(page, 'granted')
  const socket = await openTerminal(page)
  await expect(page.getByRole('button', { name: 'Desktop notifications enabled', exact: true })).toBeVisible()
  await attention(page, false)
  socket.send(Buffer.from('\x07'))
  await expect.poll(() => page.evaluate(() => window.bellNotifications.instances.length)).toBe(1)
  await attention(page, true)
  await page.evaluate(() => (window.bellNotifications.permission = 'denied'))
  await attention(page, false)
  socket.send(Buffer.from('\x07'))
  await expect(page).toHaveTitle(/rang a bell/)
  expect(await page.evaluate(() => window.bellNotifications.instances.length)).toBe(1)
  await attention(page, true)
  await page.getByRole('button', { name: 'Desktop notifications blocked', exact: true }).click()
  await expect(page.locator('.terminal-status')).toContainText('Allow them in your browser’s site settings')
  expect(await page.evaluate(() => window.bellNotifications.requests)).toBe(0)
})

for (const result of ['denied', 'default', 'error'] as const) {
  test(`notification permission ${result} keeps the terminal usable`, async ({ page }) => {
    await mockNotifications(page)
    const socket = await openTerminal(page)
    await page.evaluate(result => (window.bellNotifications.result = result), result)
    await page.getByRole('button', { name: 'Enable desktop notifications', exact: true }).click()
    const message =
      result === 'denied'
        ? 'Notifications are blocked.'
        : result === 'default'
          ? 'Desktop notifications were not enabled.'
          : 'Could not enable desktop notifications.'
    await expect(page.locator('.terminal-status')).toContainText(message)
    const label = result === 'denied' ? 'Desktop notifications blocked' : 'Enable desktop notifications'
    await expect(page.getByRole('button', { name: label, exact: true })).toBeEnabled()
    await attention(page, false)
    socket.send(Buffer.from('\x07STILL_CONNECTED\r\n'))
    await expect(page).toHaveTitle(/rang a bell/)
    await expect(page.locator('.xterm-rows')).toContainText('STILL_CONNECTED')
    expect(await page.evaluate(() => window.bellNotifications.instances.length)).toBe(0)
  })
}

for (const unavailable of ['unsupported', 'insecure'] as const) {
  test(`${unavailable} desktop notifications explain how to proceed and keep visual bells`, async ({ page }) => {
    await page.addInitScript(unavailable => {
      if (unavailable === 'unsupported') Object.defineProperty(window, 'Notification', { value: undefined })
      else Object.defineProperty(window, 'isSecureContext', { value: false })
    }, unavailable)
    const socket = await openTerminal(page)
    await page.getByRole('button', { name: /Desktop notifications (unavailable|require)/ }).click()
    await expect(page.locator('.terminal-status')).toContainText(
      unavailable === 'unsupported' ? 'does not support desktop notifications' : 'HTTPS or localhost',
    )
    await attention(page, false)
    socket.send(Buffer.from('\x07STILL_CONNECTED\r\n'))
    await expect(page).toHaveTitle(/rang a bell/)
    await expect(page.locator('.xterm-rows')).toContainText('STILL_CONNECTED')
  })
}

test('notification failures leave bells and terminal output working', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await mockNotifications(page, 'granted')
  const socket = await openTerminal(page)
  await attention(page, false)
  await page.evaluate(() => (window.bellNotifications.failConstruction = true))
  socket.send(Buffer.from('\x07CONSTRUCTOR_FAILED\r\n'))
  await expect(page.locator('.xterm-rows')).toContainText('CONSTRUCTOR_FAILED')
  await expect(page).toHaveTitle(/rang a bell/)

  await page.evaluate(() => (window.bellNotifications.failConstruction = false))
  socket.send(Buffer.from('\x07'))
  await expect.poll(() => page.evaluate(() => window.bellNotifications.instances.length)).toBe(1)
  await page.evaluate(() => window.bellNotifications.instances[0].onerror?.(new Event('error')))
  expect(await page.evaluate(() => window.bellNotifications.instances[0].closed)).toBe(true)
  socket.send(Buffer.from('\x07RECOVERED\r\n'))
  await expect(page.locator('.xterm-rows')).toContainText('RECOVERED')
  await expect.poll(() => page.evaluate(() => window.bellNotifications.instances.length)).toBe(2)
  await page.getByRole('button', { name: 'Dismiss bell notification' }).click()
  expect(await page.evaluate(() => window.bellNotifications.instances[1].closed)).toBe(true)
  expect(errors).toEqual([])
})
