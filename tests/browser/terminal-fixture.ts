import { randomBytes, createHash } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import { parseDesktopLoginCallback } from '../../shared/desktopAuth'
import type { DesktopLaunch } from '../../shared/desktopAuth'
import type { Page, WebSocketRoute } from '@playwright/test'
import headless from '@xterm/headless'
import { checkpoint } from '../../shared/terminalCheckpoint'
import { desktopBridgeVersion, type DesktopBridge } from '../../shared/desktop'

declare global {
  interface Window {
    outpostTestTicket(): Promise<string>
    outpostTestResume(token: string): Promise<void>
  }
}

/** Model the preload with credentials held by the host across page reloads. */
export async function desktopTerminal(page: Page, token: string) {
  const host = { token }
  await page.exposeFunction('outpostTestTicket', () => host.token)
  await page.exposeFunction('outpostTestResume', (token: string) => {
    host.token = token
  })
  await page.addInitScript(version => {
    const bridge: DesktopBridge = {
      version,
      notificationsSupported: true,
      ticket: () => window.outpostTestTicket(),
      saveResume: token => window.outpostTestResume(token),
      openExternal: async () => false,
      files: {
        list: async () => [],
        read: async () => new ArrayBuffer(0),
        remove: async () => {},
        download: async () => false,
      },
      viewFiles: async () => {},
      onCommand: listener => {
        const command = (event: Event) => listener((event as CustomEvent).detail)
        window.addEventListener('outpost-test-command', command)
        return () => window.removeEventListener('outpost-test-command', command)
      },
      onLaunch: () => () => {},
      launchHandled: async () => {},
      onHostState: listener => {
        let disposed = false
        queueMicrotask(() => {
          if (!disposed) listener({ focused: true, fontSize: 13.5, sound: false })
        })
        return () => {
          disposed = true
        }
      },
      reportState: async () => {},
      pasteClipboard: async () => false,
      copyText: async () => false,
      notifyBell: async () => true,
      dismissBell: async () => {},
      close: async () => window.close(),
    }
    Object.defineProperty(window, 'outpostDesktop', { value: bridge })
  }, desktopBridgeVersion)
  return host
}

/** Desktop panes keep the optional terminal toolbar behind the terminal menu. */
export async function showTerminalToolbar(page: Page) {
  await page.locator('.terminal-surface').click({ button: 'right' })
  await page.getByRole('menuitemcheckbox', { name: 'Terminal toolbar', exact: true }).click()
}

/** Browser socket fixtures use the same initial checkpoint as the real service. */
export function restoreEmptyTerminal(socket: WebSocketRoute) {
  const params = new URL(socket.url()).searchParams
  const terminal = new headless.Terminal({
    cols: Number(params.get('cols')),
    rows: Number(params.get('rows')),
    allowProposedApi: true,
  })
  try {
    for (const part of checkpoint(terminal)) socket.send(JSON.stringify({ type: 'restore', checkpoint: part }))
    socket.send(JSON.stringify({ type: 'ready' }))
  } finally {
    terminal.dispose()
  }
}

/** Obtain app-owned terminal grants through the same approval/exchange API as Electron. */
export async function appConnection(
  request: APIRequestContext,
  targetId: string,
  sessionId: string,
): Promise<DesktopLaunch> {
  const headers = { 'x-outpost-request': '1' },
    verifier = randomBytes(32).toString('base64url')
  const start = await request.post('/api/desktop/authorizations', {
    headers,
    data: {
      state: randomBytes(32).toString('base64url'),
      challenge: createHash('sha256').update(verifier).digest('base64url'),
    },
  })
  const { requestId } = await start.json()
  const approval = await request.post(`/api/desktop/authorizations/${requestId}`, {
    headers,
    data: { allow: true, accountId: 'local' },
  })
  const { code } = parseDesktopLoginCallback((await approval.json()).callback)
  const login = await request.post('/api/desktop/token', { headers, data: { code, verifier } })
  const { token } = await login.json()
  return (
    await request.post(`/api/desktop/targets/${targetId}/sessions/${sessionId}/connect`, {
      headers: { ...headers, authorization: `Bearer ${token}` },
    })
  ).json()
}
