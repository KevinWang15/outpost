import { expect, type Page, type Route, type WebSocketRoute } from '@playwright/test'
import type { SessionImageInput } from '../../shared/session-manager'
import { codingIdentity } from './session-fixture'
import { healthySoftware } from './software-fixture'

const reference = '/root/.outpost/clipboard/work/image.png'

export async function webTerminalWorkspace(page: Page, options: { hosted?: boolean; backend?: 'tmux' | 'dtach'; autoConnect?: boolean } = {}) {
  const backend = options.backend ?? 'tmux'
  const session = { ...codingIdentity('codex', 'work'), id: 'work', name: 'Composer work', backend, tool: 'codex', rootDir: '/root/project', env: {}, args: '', createdAt: '2026-10-04T00:00:00Z', lastConnectedAt: null, status: 'detached', socketPath: '/root/.outpost/sockets/work', activity: { state: 'idle', updatedAt: null, completionId: null, detail: null } }
  const inputs: string[] = [], sizes: { cols: number; rows: number }[] = [], uploads: SessionImageInput[] = [], sockets: WebSocketRoute[] = []
  const launches: { keySource: string }[] = [], errors: string[] = []
  let keyRequests = 0
  page.on('pageerror', error => errors.push(error.message))
  let upload: ((route: Route) => Promise<void>) | null = null, launch: ((route: Route) => Promise<void>) | null = null, keyStatus: ((route: Route) => Promise<void>) | null = null, pauseReconnect = false
  const snapshot = (socket: WebSocketRoute) => socket.send(JSON.stringify({ type: 'snapshot', cols: 80, rows: 24, data: '\x1b[?2004hComposer ready\r\n' }))
  await page.routeWebSocket('**/api/web-terminals/terminal/socket', socket => {
    sockets.push(socket)
    socket.onMessage(message => {
      const event = JSON.parse(message.toString())
      if (event.type === 'input') inputs.push(event.data)
      if (event.type === 'resize') sizes.push({ cols: event.cols, rows: event.rows })
    })
    if (!pauseReconnect) snapshot(socket)
  })
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/session') return route.fulfill({ json: { mode: options.hosted ? 'hosted' : 'local', user: options.hosted ? { id: 'user', email: 'user@example.com', name: 'Composer user', emailVerifiedAt: session.createdAt, createdAt: session.createdAt } : null } })
    if (path === '/api/environment') return route.fulfill({ json: { platform: 'linux', supported: true, usesWsl: false } })
    if (path === '/api/targets') return route.fulfill({ json: [{ id: 'composer', kind: 'ssh', name: 'Composer', host: 'dev.example.com', backends: [backend], tools: ['codex'], createdAt: session.createdAt }] })
    if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware([backend], ['codex']) })
    if (path.endsWith('/sessions')) return route.fulfill({ json: { sessions: [session], registryPath: '/root/.outpost/sessions.json' } })
    if (path.endsWith('/terminal-key')) {
      keyRequests++
      return keyStatus ? keyStatus(route) : route.fulfill({ json: { encryptionAvailable: true, key: { fingerprint: 'uploaded', type: 'ssh-ed25519', uploadedAt: session.createdAt, hostFingerprint: null }, ...(options.hosted ? { accountKey: { publicKey: 'ssh-ed25519 fixture', fingerprint: 'account' } } : {}) } })
    }
    if (path.endsWith('/web-terminal')) {
      expect(route.request().headers()['x-outpost-request']).toBe('1')
      launches.push(route.request().postDataJSON())
      return launch ? launch(route) : route.fulfill({ json: { id: 'terminal', cols: 80, rows: 24, reconnectSeconds: 600 } })
    }
    if (path === '/api/web-terminals/terminal' && route.request().method() === 'DELETE') return route.fulfill({ status: 204 })
    if (path === '/api/targets/composer/sessions/work/image') {
      expect(route.request().headers()['x-outpost-request']).toBe('1')
      uploads.push(route.request().postDataJSON())
      return upload ? upload(route) : route.fulfill({ json: { path: reference, reference, injected: backend === 'tmux' } })
    }
    throw new Error(`Unexpected request: ${route.request().method()} ${path}`)
  })
  await page.goto('/')
  await expect(page.getByText('Composer work', { exact: true })).toBeVisible()
  const open = async (differentKey = false) => {
    if (options.hosted && !differentKey) await page.getByRole('button', { name: 'Connect using web terminal', exact: true }).click()
    else {
      await page.getByRole('button', { name: 'Connection options for Composer work', exact: true }).click()
      await page.getByRole('menuitem', { name: options.hosted ? 'Connect with another SSH key' : 'Launch with web terminal', exact: true }).click()
    }
  }
  if (options.autoConnect !== false) {
    await open()
    await expect(page.locator('.terminal-toolbar')).toContainText('Connected')
  }
  return {
    inputs, sizes, uploads, sockets, errors, launches, open,
    get keyRequests() { return keyRequests },
    onLaunch: (handler: (route: Route) => Promise<void>) => { launch = handler },
    onKeyStatus: (handler: (route: Route) => Promise<void>) => { keyStatus = handler },
    onUpload: (handler: (route: Route) => Promise<void>) => { upload = handler },
    disconnect: () => { pauseReconnect = true; sockets.at(-1)!.close({ code: 1012, reason: 'Fixture disconnect' }) },
    reconnect: () => { pauseReconnect = false; snapshot(sockets.at(-1)!) },
  }
}
