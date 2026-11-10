import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { BrowserWindow, ipcMain, Menu, session, shell, type IpcMainInvokeEvent } from 'electron'
import { desktopOrigin } from '../../shared/desktopAuth'
import { browserUrl } from '../../shared/signals'
import { chatNavigationAllowed, chatPageUrl } from './chat-policy'

interface Host {
  ticket(origin: string): Promise<{ ticket: string }>
  openTerminal(origin: string, targetId: string, sessionId: string): Promise<void>
}

/** One chat window per server account. The page is the server's /chat/desktop;
 * its preload gets single-use chat tickets from the app login, so the window
 * holds no account bearer and no browser cookie. */
export class ChatWindows {
  private windows = new Map<string, BrowserWindow>()
  private links = new WeakMap<BrowserWindow, number>()

  constructor(
    private directory: string,
    private host: Host,
  ) {
    ipcMain.handle('chat:ticket', event => this.host.ticket(this.sender(event)))
    ipcMain.handle('chat:open-link', async (event, value: unknown) => {
      const origin = this.sender(event)
      const window = this.windows.get(origin)!
      if (Date.now() - (this.links.get(window) ?? 0) < 500) return false
      this.links.set(window, Date.now())
      await shell.openExternal(browserUrl({ url: value }))
      return true
    })
    ipcMain.handle('chat:open-terminal', (event, targetId: unknown, sessionId: unknown) => {
      const origin = this.sender(event)
      if (
        typeof targetId !== 'string' ||
        targetId.length > 80 ||
        typeof sessionId !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(sessionId)
      )
        throw new Error('Invalid session.')
      return this.host.openTerminal(origin, targetId, sessionId)
    })
  }

  /** The server origin of a chat window's main frame; anything else is refused. */
  private sender(event: IpcMainInvokeEvent) {
    for (const [origin, window] of this.windows)
      if (
        !window.isDestroyed() &&
        event.sender === window.webContents &&
        event.senderFrame === window.webContents.mainFrame &&
        chatNavigationAllowed(origin, event.senderFrame.url)
      )
        return origin
    throw new Error('This action is only available in an Outpost chat window.')
  }

  open(server: string) {
    const origin = desktopOrigin(server)
    const existing = this.windows.get(origin)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return
    }
    const partition = 'outpost-chat-' + createHash('sha256').update(origin).digest('hex')
    const browserSession = session.fromPartition(partition, { cache: false })
    // Copy buttons write the clipboard; nothing else is granted.
    browserSession.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write')
    browserSession.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(permission === 'clipboard-sanitized-write'),
    )
    browserSession.on('will-download', event => event.preventDefault())
    const window = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 360,
      minHeight: 480,
      title: `Outpost chat · ${new URL(origin).host}`,
      backgroundColor: '#f7f9fc',
      autoHideMenuBar: true,
      icon: join(this.directory, 'outpost.png'),
      webPreferences: {
        preload: join(this.directory, 'chat-preload.cjs'),
        session: browserSession,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        allowRunningInsecureContent: false,
      },
    })
    this.windows.set(origin, window)
    const contents = window.webContents
    contents.setWindowOpenHandler(({ url }) => {
      // Links go to the system browser through the validated bridge path.
      try {
        void shell.openExternal(browserUrl({ url }))
      } catch {
        /* Not an http(s) link. */
      }
      return { action: 'deny' }
    })
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('will-frame-navigate', event => {
      if (!event.isMainFrame || !chatNavigationAllowed(origin, event.url)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (!chatNavigationAllowed(origin, url)) event.preventDefault()
    })
    contents.on('context-menu', (_event, params) => {
      const menu = Menu.buildFromTemplate([
        ...(params.isEditable
          ? [
              { label: 'Cut', enabled: params.editFlags.canCut, click: () => contents.cut() },
              { label: 'Copy', enabled: params.editFlags.canCopy, click: () => contents.copy() },
              { label: 'Paste', enabled: params.editFlags.canPaste, click: () => contents.paste() },
              { type: 'separator' as const },
              { label: 'Select all', enabled: params.editFlags.canSelectAll, click: () => contents.selectAll() },
            ]
          : params.selectionText
            ? [{ label: 'Copy', click: () => contents.copy() }]
            : []),
      ])
      if (menu.items.length) menu.popup({ window })
    })
    window.on('closed', () => {
      if (this.windows.get(origin) === window) this.windows.delete(origin)
    })
    void window.loadURL(chatPageUrl(origin)).catch(() => {})
  }

  /** Signing out of a server closes its chat window. */
  close(server: string) {
    const window = this.windows.get(desktopOrigin(server))
    if (window && !window.isDestroyed()) window.destroy()
  }

  dispose() {
    for (const window of this.windows.values()) if (!window.isDestroyed()) window.destroy()
    this.windows.clear()
  }
}
