import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'

const ticketKey = 'outpost.desktop.ticket'

async function session(page: Page) {
  const headers = { 'x-outpost-request': '1' }
  const fixture = randomUUID()
  const target = await (
    await page.request.post('/api/targets', {
      headers,
      data: { kind: 'local', name: `App box ${fixture}`, tools: ['claude'] },
    })
  ).json()
  const created = await (
    await page.request.post(`/api/targets/${target.id}/sessions`, {
      headers,
      data: {
        name: `App session ${fixture}`,
        rootDir: `~/app-project-${fixture}`,
        tool: 'claude',
        createDirectory: true,
      },
    })
  ).json()
  expect(target.id).toBeTruthy()
  expect(created.id).toBeTruthy()
  return (
    await page.request.post(`/api/targets/${target.id}/sessions/${created.id}/connect`, {
      headers,
      data: { terminal: 'desktop' },
    })
  ).json() as Promise<{ token: string; id: string; url: string }>
}

test('app tickets attach without a browser login; reload and toolbar changes reuse the shared client', async ({
  page,
  context,
}) => {
  const connection = await session(page)
  const sockets: string[] = []
  const requests: string[] = []
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname === '/api/terminal') sockets.push(socket.url())
  })
  page.on('request', request => requests.push(request.url()))
  await context.clearCookies()
  // A hosted anonymous browser would be stopped by AuthGate. The app entry
  // must never ask it for an account, or mint another connection ticket.
  await page.route('**/api/auth/session', route => route.fulfill({ json: { mode: 'hosted', user: null } }))
  await page.goto(`/terminal/desktop#token=${connection.token}`)
  await expect(page.locator('.xterm-rows')).toContainText('OUTPOST_FIXTURE_READY')
  await expect(page).toHaveURL(/\/terminal\/desktop$/)
  await expect(page).toHaveTitle(/^App session .* · App box .* · Outpost$/)
  expect(sockets).toHaveLength(1)
  expect(new URL(sockets[0]).searchParams.get('token')).toBe(connection.token)
  const resume = await page.evaluate(key => sessionStorage.getItem(key), ticketKey)
  expect(resume).toBeTruthy()
  expect(resume).not.toBe(connection.token)
  expect(await page.evaluate(key => localStorage.getItem(key), ticketKey)).toBeNull()
  expect((await (await page.request.get(`/api/connections/${connection.id}`)).json()).status).toBe('connected')

  const before = await page.locator('.terminal-surface').evaluate(element => element.clientHeight)
  await page.getByRole('button', { name: 'Hide terminal toolbar' }).click()
  await expect(page.locator('.terminal-bar')).toBeHidden()
  await expect
    .poll(() => page.locator('.terminal-surface').evaluate(element => element.clientHeight))
    .toBeGreaterThan(before)
  expect(sockets).toHaveLength(1)
  await page.reload()
  await expect(page.locator('.xterm-rows')).toContainText('OUTPOST_FIXTURE_READY')
  expect(sockets).toHaveLength(2)
  expect(new URL(sockets[1]).searchParams.get('token')).toBe(resume)
  await expect(page.getByRole('button', { name: 'Show terminal toolbar' })).toBeVisible()
  await page.getByRole('button', { name: 'Show terminal toolbar' }).click()
  await expect(page.locator('.terminal-bar')).toBeVisible()
  expect(sockets).toHaveLength(2)
  expect(
    requests.some(
      url => url.includes('#token=') || url.includes('/api/auth/') || new URL(url).pathname.endsWith('/connect'),
    ),
  ).toBe(false)
  await expect(page.getByRole('button', { name: /notifications/i })).toBeVisible()

  // Other app windows neither inherit nor overwrite this one's resume grant.
  const other = await context.newPage()
  await other.goto('/terminal/desktop')
  await expect(other.getByText('Choose a session in Outpost, then Connect → Outpost Desktop.')).toBeVisible()
  expect(await other.evaluate(key => sessionStorage.getItem(key), ticketKey)).toBeNull()
  // Replaying the original launch ticket fails at the real broker, and the
  // rejected ticket is cleared so reload cannot retry it indefinitely.
  // Load a new document as the app does; changing only a fragment does not reload this browser page.
  await other.goto('about:blank')
  await other.goto(`/terminal/desktop#token=${connection.token}`)
  await expect(other.getByRole('heading', { name: 'Connection expired' })).toBeVisible()
  expect(await other.evaluate(key => sessionStorage.getItem(key), ticketKey)).toBeNull()
  await other.reload()
  await expect(other.getByRole('button', { name: 'Open Outpost' })).toBeVisible()
  await expect(page.locator('.terminal-state')).toHaveText('Connected')
  await other.close()
})

test('malformed launch fragments clear old grants and never open a socket', async ({ page }) => {
  const sockets: string[] = []
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname === '/api/terminal') sockets.push(socket.url())
  })
  await page.addInitScript(key => sessionStorage.setItem(key, 'stale.signature'), ticketKey)
  await page.goto('/terminal/desktop#token=invalid%20ticket')
  await expect(page.getByRole('button', { name: 'Open Outpost' })).toBeVisible()
  await expect(page).toHaveURL(/\/terminal\/desktop$/)
  expect(await page.evaluate(key => sessionStorage.getItem(key), ticketKey)).toBeNull()
  expect(sockets).toEqual([])
})

test('storage restrictions do not prevent a launch or leave its ticket in the URL', async ({ page }) => {
  const connection = await session(page)
  await page.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', {
      get() {
        throw new Error('Storage disabled')
      },
    })
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('Storage disabled')
      },
    })
  })
  await page.goto(`/terminal/desktop#token=${connection.token}`)
  await expect(page.locator('.xterm-rows')).toContainText('OUTPOST_FIXTURE_READY')
  await expect(page).toHaveURL(/\/terminal\/desktop$/)
  await page.getByRole('button', { name: 'Hide terminal toolbar' }).click()
  await page.getByRole('button', { name: 'Show terminal toolbar' }).click()
  await expect(page.locator('.terminal-state')).toHaveText('Connected')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Open Outpost' })).toBeVisible()
})
