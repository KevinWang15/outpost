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
      onCommand: () => () => {},
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
