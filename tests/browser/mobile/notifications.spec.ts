import type { Page } from '@playwright/test'
import { test, expect, mockTerminal, attention, fitsScreen } from './helpers'

declare global {
  interface Window {
    mobileNotifications: {
      permission: NotificationPermission
      permissionResult: NotificationPermission | 'pending'
      permissionRequests: number
      gestures: boolean[]
      registrations: number
      failRegistration: boolean
      hangRegistration: boolean
      delayShow: boolean
      entries: {
        title: string
        options: NotificationOptions
        data: { id: string; url: string }
        closed: boolean
        close(): void
      }[]
      finishShows: (() => void)[]
    }
  }
}

async function notifications(
  page: Page,
  permission: NotificationPermission = 'granted',
  failure?: 'reject' | 'timeout',
) {
  await page.addInitScript(
    ({ permission, failure }) => {
      Object.defineProperty(navigator, 'standalone', { value: true })
      const state = (window.mobileNotifications = {
        permission,
        permissionResult: 'granted',
        permissionRequests: 0,
        gestures: [],
        registrations: 0,
        failRegistration: failure === 'reject',
        hangRegistration: failure === 'timeout',
        delayShow: false,
        entries: [],
        finishShows: [],
      } as Window['mobileNotifications'])
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: class {
          static get permission() {
            return state.permission
          }
          static async requestPermission() {
            state.permissionRequests++
            state.gestures.push(navigator.userActivation.isActive)
            if (state.permissionResult === 'pending') return new Promise(() => {})
            return (state.permission = state.permissionResult)
          }
          constructor() {
            throw new Error('Mobile must use ServiceWorkerRegistration.showNotification')
          }
        },
      })
      const registration = {
        active: Object.assign(new EventTarget(), { state: 'activated' }),
        async showNotification(title: string, options: NotificationOptions & { data: { id: string; url: string } }) {
          state.entries.push({
            title,
            options,
            data: options.data,
            closed: false,
            close() {
              this.closed = true
            },
          })
          if (state.delayShow) await new Promise<void>(resolve => state.finishShows.push(resolve))
        },
        async getNotifications({ tag }: { tag: string }) {
          return state.entries.filter(entry => entry.options.tag === tag)
        },
      }
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          async register() {
            state.registrations++
            if (state.failRegistration) throw new Error('Registration unavailable')
            if (state.hangRegistration) return new Promise(() => {})
            return registration
          },
        },
      })
    },
    { permission, failure },
  )
}

test('permission uses a touch gesture and an unanswered prompt stops spinning without blocking the terminal', async ({
  page,
}) => {
  await notifications(page, 'default')
  await page.clock.install()
  const terminal = await mockTerminal(page)
  await page.evaluate(() => {
    window.mobileNotifications.permissionResult = 'pending'
  })
  const bell = page.getByRole('button', { name: 'Enable notifications', exact: true })
  await bell.tap()
  await expect(bell).toBeDisabled()
  expect(await page.evaluate(() => window.mobileNotifications.gestures)).toEqual([true])
  await page.clock.fastForward(8100)
  await expect(bell).toBeEnabled()
  await expect(page.locator('.terminal-notice')).toContainText('Still waiting')
  await fitsScreen(page)
  await bell.tap()
  expect(await page.evaluate(() => window.mobileNotifications.permissionRequests)).toBe(1)
  terminal.output('OUTPUT_WHILE_PERMISSION_PENDING\r\n')
  await expect(page.locator('.xterm-rows')).toContainText('OUTPUT_WHILE_PERMISSION_PENDING')
  await page.evaluate(() => {
    window.mobileNotifications.permission = 'granted'
    window.dispatchEvent(new Event('focus'))
  })
  await expect(page.getByRole('button', { name: 'Notifications allowed' })).toBeEnabled()
  await expect.poll(() => page.evaluate(() => window.mobileNotifications.registrations)).toBe(1)
})

test('service-worker bells group alerts and late cleanup cannot dismiss a newer notification', async ({ page }) => {
  await notifications(page)
  const terminal = await mockTerminal(page)
  await page.evaluate(() => {
    window.mobileNotifications.delayShow = true
    history.replaceState(null, '', location.href + '&token=SECRET&title=Private#resume=SECRET')
  })
  await attention(page, false)
  terminal.output('\x07\x07\x07')
  await expect.poll(() => page.evaluate(() => window.mobileNotifications.entries.length)).toBe(1)
  const first = await page.evaluate(() => window.mobileNotifications.entries[0].options)
  expect(first).toMatchObject({
    tag: 'outpost-bell:mobile-target/mobile-session',
    data: {
      url: 'http://127.0.0.1:4178/terminal?target=mobile-target&session=mobile-session',
    },
  })
  expect(JSON.stringify(first)).not.toContain('SECRET')
  await attention(page, true)
  await attention(page, false)
  terminal.output('\x07')
  await expect.poll(() => page.evaluate(() => window.mobileNotifications.entries.length)).toBe(2)
  await page.evaluate(() => {
    window.mobileNotifications.finishShows[1]()
  })
  await page.evaluate(() => {
    window.mobileNotifications.finishShows[0]()
  })
  await expect
    .poll(() => page.evaluate(() => window.mobileNotifications.entries.map(e => e.closed)))
    .toEqual([true, false])
  await attention(page, true)
  await expect
    .poll(() => page.evaluate(() => window.mobileNotifications.entries.map(e => e.closed)))
    .toEqual([true, true])
})

for (const failure of ['reject', 'timeout'] as const) {
  test(`notification setup ${failure} is recoverable from the bell button`, async ({ page }) => {
    await notifications(page, 'granted', failure)
    await page.clock.install()
    await mockTerminal(page)
    if (failure === 'timeout') await page.clock.fastForward(10_100)
    await expect(page.locator('.terminal-notice')).toContainText('setup failed')
    await page.evaluate(() => {
      window.mobileNotifications.failRegistration = false
      window.mobileNotifications.hangRegistration = false
    })
    await page.getByRole('button', { name: 'Notifications allowed' }).tap()
    await expect.poll(() => page.evaluate(() => window.mobileNotifications.registrations)).toBe(2)
    await expect(page.locator('.terminal-notice')).toContainText('while this terminal is running')
  })
}

test('iPhone and desktop-mode iPad explain Home Screen setup instead of asking for unavailable permission', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' })
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5 })
    Object.defineProperty(navigator, 'standalone', { value: false })
    Object.defineProperty(window, 'Notification', { value: undefined })
  })
  const terminal = await mockTerminal(page)
  await page.getByRole('button', { name: 'Add Outpost to Home Screen for notifications' }).tap()
  await expect(page.locator('.terminal-notice')).toContainText('Share → Add to Home Screen')
  await fitsScreen(page)
  terminal.output('\x07LIVE_WITHOUT_NOTIFICATIONS\r\n')
  await expect(page.locator('.xterm-rows')).toContainText('LIVE_WITHOUT_NOTIFICATIONS')
  await expect(page.locator('.terminal-bell')).toBeVisible()
})

test('the actual notification worker activates without caches; Chromium also registers and dismisses alerts', async ({
  page,
  context,
  browserName,
}) => {
  if (browserName === 'chromium') await context.grantPermissions(['notifications'])
  const terminal = await mockTerminal(page)
  // WebKit cannot grant Home Screen notification permission in headless mode. Still exercise
  // the real transport's registration/activation path, without replacing its service-worker API.
  if (browserName !== 'chromium')
    await page.evaluate(async () => {
      const path = '/frontend/terminal/notificationTransport.ts'
      const { prepareBrowserNotifications } = await import(path)
      await prepareBrowserNotifications()
    })
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration('/terminal')
        return registration?.active?.state
      }),
    )
    .toBe('activated')
  expect(await page.evaluate(() => caches.keys())).toEqual([])
  if (browserName !== 'chromium') return
  await attention(page, false)
  terminal.output('\x07')
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration('/terminal')
        return (await registration!.getNotifications()).length
      }),
    )
    .toBe(1)
  await attention(page, true)
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration('/terminal')
        return (await registration!.getNotifications()).length
      }),
    )
    .toBe(0)
})
