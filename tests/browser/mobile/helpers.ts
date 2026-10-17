import { expect, test as base, type Page, type WebSocketRoute } from '@playwright/test'
import type { ClientMessage, ServerMessage } from '../../../shared/protocol'
import { restoreEmptyTerminal } from '../terminal-fixture'

export const test = base.extend({
  page: async ({ page, context }, use) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    context.on('page', popup => popup.on('pageerror', error => errors.push(error.message)))
    // Inspect xterm's DOM fallback deterministically on both engines. GPU coverage lives separately.
    await context.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type, ...args) {
        if (String(type).includes('webgl')) return null
        return getContext.call(this, type, ...args)
      } as typeof getContext
    })
    await use(page)
    expect(errors, 'No uncaught browser errors').toEqual([])
  },
})
export { expect }

export async function mockTerminal(page: Page, options: { acknowledgeSends?: boolean; inspectDom?: boolean } = {}) {
  const sockets: WebSocketRoute[] = []
  const messages: ClientMessage[] = []
  const input: Buffer[] = []
  const state = { answerPings: true }
  const send = (message: ServerMessage) => sockets.at(-1)!.send(JSON.stringify(message))
  await page.route('**/api/targets/mobile-target/sessions/mobile-session/connect', route =>
    route.fulfill({ json: { token: 'mobile-ticket' } }),
  )
  await page.routeWebSocket(/\/api\/terminal\?/, ws => {
    sockets.push(ws)
    ws.onMessage(data => {
      if (Buffer.isBuffer(data)) input.push(data)
      else {
        const message = JSON.parse(data) as ClientMessage
        messages.push(message)
        if (message.type === 'resize') send({ type: 'geometry', cols: message.cols, rows: message.rows })
        if (
          (message.type === 'ping' && state.answerPings) ||
          (message.type === 'send' && options.acknowledgeSends !== false)
        )
          ws.send(JSON.stringify({ type: 'result', id: message.id, ok: true }))
      }
    })
    send({
      type: 'hello',
      resume: 'mobile-resume',
      session: { id: 'mobile-session', name: 'Mobile session' },
      target: { id: 'mobile-target', name: 'Development' },
    })
    restoreEmptyTerminal(ws)
  })
  await page.goto('/terminal?target=mobile-target&session=mobile-session')
  await expect(page.getByRole('status', { name: 'Connected', exact: true })).toBeVisible()
  const output = (text: string) => sockets.at(-1)!.send(Buffer.from(text))
  output('MOBILE_READY\r\n')
  if (options.inspectDom !== false) await expect(page.locator('.xterm-rows')).toContainText('MOBILE_READY')
  return { sockets, messages, input, state, send, output }
}

export async function attention(page: Page, focused: boolean) {
  await page.evaluate(focused => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: focused ? 'visible' : 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event(focused ? 'focus' : 'blur'))
  }, focused)
}

export async function viewport(
  page: Page,
  values: Partial<Pick<VisualViewport, 'height' | 'width' | 'offsetTop' | 'offsetLeft' | 'scale'>>,
) {
  await page.evaluate(values => {
    for (const [key, value] of Object.entries(values))
      Object.defineProperty(window.visualViewport!, key, { configurable: true, value })
    window.visualViewport!.dispatchEvent(new Event('resize'))
    window.visualViewport!.dispatchEvent(new Event('scroll'))
  }, values)
}

export async function fitsScreen(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)
  for (const selector of ['.terminal-bar', '.key-bar', '.composer:not([hidden])']) {
    const bounds = await page.locator(selector).boundingBox()
    if (!bounds) continue
    const screen = await page.evaluate(() => ({
      width: window.visualViewport!.width,
      height: window.visualViewport!.height,
      top: window.visualViewport!.offsetTop,
    }))
    expect(bounds.x, selector).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width, selector).toBeLessThanOrEqual(screen.width + 1)
    expect(bounds.y, selector).toBeGreaterThanOrEqual(screen.top - 1)
    expect(bounds.y + bounds.height, selector).toBeLessThanOrEqual(screen.top + screen.height + 1)
  }
  for (const button of await page.locator('.terminal-actions button:visible').all()) {
    const bounds = (await button.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(await page.evaluate(() => window.visualViewport!.width + 1))
  }
}
