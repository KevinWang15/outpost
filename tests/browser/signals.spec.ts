import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Accounts } from '../../backend/accounts'
import { createApp } from '../../backend/app'
import { Signals } from '../../backend/signals'

test('hosted SSE opens once across windows, handles blocked popups, and revokes delivery on sign-out', async ({ context, page: first }) => {
  test.setTimeout(60000)
  const directory = await mkdtemp(join(tmpdir(), 'outpost-browser-signals-'))
  const accounts = await Accounts.open({ directory, publicUrl: 'http://127.0.0.1:4178', production: false, mailer: null })
  const user = accounts.store.create('signals@example.com', 'Signals user', 'unused')
  const verified = accounts.store.consumeToken(accounts.store.issueToken(user.id, 'verify', 10000), 'verify')!
  const login = accounts.store.issueSession(verified), owner = { userId: user.id, authSessionId: login.id }
  const signals = new Signals(value => accounts.store.ticketSession(value.userId, value.authSessionId))
  const token = signals.issue(owner, 'target', 'session')
  const app = await createApp({ accounts, signals, frontendRoot: fileURLToPath(new URL('../../dist/client/', import.meta.url)) })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
  const message = (id = randomUUID()) => ({ version: 1, id, type: 'browser.open', payload: { url: `https://signal.example/${id}?fileName=hello.zip&x=1` } })
  const popups: Page[] = [], errors: string[] = []
  const watch = (page: Page) => {
    page.on('popup', popup => popups.push(popup))
    page.on('pageerror', error => errors.push(error.message))
  }
  const listeners = new Map<Page, string>()
  const load = async (page: Page) => {
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.pathname === '/api/signals/events') listeners.set(page, url.searchParams.get('id')!)
    })
    const registered = page.waitForResponse(response => response.url().endsWith('/activity') && response.status() === 204)
    await page.goto(origin)
    await registered
  }
  const focus = async (page: Page, focused: boolean) => {
    const response = await page.request.post(`${origin}/api/signals/listeners/${listeners.get(page)}/activity`, {
      headers: { 'x-outpost-request': '1' }, data: { focused, visible: true },
    })
    expect(response.status()).toBe(204)
  }
  try {
    await expect(signals.dispatch(token, message())).rejects.toMatchObject({ statusCode: 503 })
    expect((await app.inject({ url: '/api/signals/events?id=' + randomUUID() + '&types=browser.open', headers: { host: '127.0.0.1' } })).statusCode).toBe(401)
    await context.addCookies([{ name: 'outpost_session', value: login.token, url: origin, httpOnly: true, sameSite: 'Lax' }])
    await context.route('https://signal.example/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Opened from terminal</title>' }))
    const second = await context.newPage()
    watch(first); watch(second)
    await load(first); await load(second)
    await focus(first, false); await focus(second, true)
    const signal = message()
    const popupEvent = second.waitForEvent('popup')
    await Promise.all(Array.from({ length: 12 }, () => signals.dispatch(token, signal)))
    const popup = await popupEvent
    await popup.waitForURL(signal.payload.url)
    expect(await popup.evaluate(() => window.opener)).toBeNull()
    expect(popups).toHaveLength(1)
    await popup.close()
    const reconnected = first.waitForResponse(response => response.url().endsWith('/activity') && response.status() === 204)
    await first.reload(); await reconnected
    await signals.dispatch(token, signal)
    await second.close()
    await focus(first, true)
    const next = message(), nextPopup = first.waitForEvent('popup')
    await signals.dispatch(token, next)
    await (await nextPopup).waitForURL(next.payload.url)
    expect(popups).toHaveLength(2)
    await popups[1].close()

    await first.evaluate(() => {
      const open = window.open
      window.open = () => null
      document.addEventListener('restore-test-open', () => { window.open = open }, { once: true })
    })
    const blocked = message()
    await signals.dispatch(token, blocked)
    await expect(first.getByRole('dialog', { name: 'Open link from your terminal' })).toBeVisible()
    await expect(first.locator('.browser-signal-url')).toHaveText(blocked.payload.url)
    expect(popups).toHaveLength(2)
    await first.evaluate(() => document.dispatchEvent(new Event('restore-test-open')))
    const manual = first.waitForEvent('popup')
    await first.getByRole('button', { name: 'Open link', exact: true }).click()
    await (await manual).waitForURL(blocked.payload.url)
    await expect(first.getByRole('dialog', { name: 'Open link from your terminal' })).toHaveCount(0)
    await signals.dispatch(token, blocked)
    expect(popups).toHaveLength(3)
    await expect(signals.dispatch(token, { ...message(), payload: { url: 'javascript:alert(1)' } })).rejects.toMatchObject({ statusCode: 400 })
    const logout = await first.request.post(`${origin}/api/auth/logout`, { headers: { 'x-outpost-request': '1' } })
    expect(logout.status()).toBe(204)
    await expect(signals.dispatch(token, message())).rejects.toMatchObject({ statusCode: 401 })
    expect(errors).toEqual([])
  } finally {
    await context.close(); await app.close(); await rm(directory, { recursive: true, force: true })
  }
})
