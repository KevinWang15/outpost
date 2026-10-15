import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  BrowserWindow,
  Menu,
  Notification,
  clipboard,
  dialog,
  ipcMain,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron'
import type { DesktopLaunch } from '../../shared/desktop'
import { pagePaths } from '../../shared/pages'
import { browserUrl } from '../../shared/signals'

interface TerminalWindow {
  window: BrowserWindow
  origin: string
  notification: Notification | null
  externalAt: number
}

export class TerminalWindows {
  private windows = new Map<number, TerminalWindow>()
  private sessions = new WeakSet<Electron.Session>()
  private launches = new Map<string, BrowserWindow>()
  constructor(private directory: string) {
    ipcMain.handle('terminal:open-external', async (event, value: unknown) => {
      const state = this.sender(event)
      const url = browserUrl({ url: value })
      if (Date.now() - state.externalAt < 500) return false
      state.externalAt = Date.now()
      try {
        await shell.openExternal(url)
        return true
      } catch {
        return false
      }
    })
    ipcMain.handle('terminal:copy', (event, value: unknown) => {
      const { window } = this.sender(event)
      if (!window.isFocused() || typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024 * 1024)
        return false
      clipboard.writeText(value)
      return true
    })
    ipcMain.handle('terminal:paste', event => {
      const { window } = this.sender(event)
      if (!window.isFocused()) return false
      window.webContents.paste()
      return true
    })
    ipcMain.handle('terminal:bell', (event, name: unknown) => {
      const state = this.sender(event)
      if (typeof name !== 'string' || name.length > 512) return false
      if (!Notification.isSupported() || state.window.isFocused()) return false
      if (state.notification) return true
      const notification = new Notification({
        title: 'Outpost · Terminal bell',
        body: `${[...name].filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('')} rang a bell`,
        icon: join(this.directory, 'outpost.png'),
        silent: true,
      })
      state.notification = notification
      notification.on('click', () => this.focus(state.window))
      notification.on('close', () => {
        if (state.notification === notification) state.notification = null
      })
      notification.on('failed', () => this.dismiss(state))
      notification.show()
      return true
    })
    ipcMain.handle('terminal:dismiss-bell', event => this.dismiss(this.sender(event)))
    ipcMain.handle('terminal:close', event => this.sender(event).window.close())
  }

  private allowed(value: string, origin: string) {
    try {
      const url = new URL(value)
      return url.origin === origin && url.pathname === pagePaths.desktopTerminal && !url.search
    } catch {
      return false
    }
  }

  private sender(event: IpcMainInvokeEvent) {
    const state = this.windows.get(event.sender.id)
    if (!state || event.senderFrame !== event.sender.mainFrame || !this.allowed(event.senderFrame.url, state.origin))
      throw new Error('Desktop action is unavailable in this page.')
    return state
  }

  private dismiss(state: TerminalWindow) {
    const notification = state.notification
    state.notification = null
    if (notification) {
      notification.removeAllListeners()
      notification.close()
    }
  }

  focus(window: BrowserWindow) {
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    window.webContents.focus()
  }

  selectAll(window: BrowserWindow | null) {
    if (!window || window.isDestroyed()) return
    if (this.windows.has(window.webContents.id)) window.webContents.send('terminal:select-all')
    else window.webContents.selectAll()
  }

  forget(origin: string) {
    for (const state of this.windows.values()) if (state.origin === origin) state.window.close()
  }

  open(launch: DesktopLaunch) {
    const existing = this.launches.get(launch.token)
    if (existing && !existing.isDestroyed()) {
      this.focus(existing)
      return
    }
    if (this.windows.size >= 16) throw new Error('Close a terminal window before opening another one.')
    // Non-persistent sessions isolate servers; the desktop never imports browser cookies.
    const partition = 'outpost-' + createHash('sha256').update(launch.server).digest('hex')
    const browserSession = session.fromPartition(partition, { cache: false })
    if (!this.sessions.has(browserSession)) {
      this.sessions.add(browserSession)
      // Native paste events handle text/images; do not grant arbitrary web clipboard reads.
      browserSession.setPermissionCheckHandler(() => false)
      browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      browserSession.on('will-download', event => event.preventDefault())
    }
    const window = new BrowserWindow({
      title: 'Outpost',
      width: 1200,
      height: 800,
      minWidth: 480,
      minHeight: 320,
      backgroundColor: '#0f172a',
      icon: join(this.directory, 'outpost.png'),
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(this.directory, 'preload.cjs'),
        session: browserSession,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
        additionalArguments: Notification.isSupported() ? ['--outpost-notifications'] : [],
      },
    })
    const state: TerminalWindow = { window, origin: launch.server, notification: null, externalAt: 0 }
    const id = window.webContents.id
    this.windows.set(id, state)
    this.launches.set(launch.token, window)
    window.on('focus', () => this.dismiss(state))
    window.on('closed', () => {
      this.dismiss(state)
      this.windows.delete(id)
      this.launches.delete(launch.token)
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    const navigation = (event: Electron.Event, url: string) => {
      if (!this.allowed(url, launch.server)) event.preventDefault()
    }
    window.webContents.on('will-navigate', navigation)
    window.webContents.on('will-redirect', navigation)
    window.webContents.on('context-menu', (_event, params) => {
      // Keep Chromium's editing gestures, including image paste, in the shared UI.
      const menu = Menu.buildFromTemplate([
        { role: 'copy', enabled: params.selectionText.length > 0 },
        { role: 'paste' },
        { type: 'separator' },
        { label: 'Select all', click: () => this.selectAll(window) },
      ])
      menu.popup({ window })
    })
    let reporting = false
    window.webContents.on('did-fail-load', async (_event, code, _description, _url, mainFrame) => {
      if (!mainFrame || code === -3 || reporting || window.isDestroyed()) return
      reporting = true
      window.show()
      await dialog.showMessageBox(window, {
        type: 'error',
        title: 'Outpost',
        message: 'Could not load the terminal.',
        detail: `Check your connection to ${launch.server}, then connect again from Outpost.`,
        buttons: ['OK'],
      })
      reporting = false
    })
    window.webContents.on('render-process-gone', () => {
      if (!window.isDestroyed())
        void dialog.showMessageBox(window, {
          type: 'error',
          title: 'Outpost',
          message: 'The terminal window stopped responding.',
          detail: 'Reload the window to reconnect. Your remote session keeps running.',
          buttons: ['OK'],
        })
    })
    window.once('ready-to-show', () => this.focus(window))
    // desktopTicket erases this single-use fragment before the shared UI renders.
    void window.loadURL(`${launch.server}${pagePaths.desktopTerminal}#token=${launch.token}`).catch(() => {})
  }
}
