import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  Menu,
  Notification,
  WebContentsView,
  clipboard,
  ipcMain,
  session,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from 'electron'
import type { DesktopLaunch, TerminalHostState, TerminalTabState } from '../../shared/desktop'
import { pagePaths } from '../../shared/pages'
import { browserUrl } from '../../shared/signals'

export interface TerminalTab {
  id: number
  view: WebContentsView
  origin: string
  label: string | null
  state: TerminalTabState
  error: string | null
  notification: Notification | null
  externalAt: number
  launchKey: string
}
interface Host {
  window(): BrowserWindow | null
  focused(id: number): boolean
  activate(id: number): void
  close(id: number): Promise<void>
  removed(id: number): void
  changed(): void
  state(id: number): TerminalHostState
}
const cleanTitle = (value: string) =>
  [...value]
    .filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join('')
    .slice(0, 512)

/** Owns isolated terminal contents and their narrow native capabilities. */
export class TerminalTabs {
  readonly tabs = new Map<number, TerminalTab>()
  private sessions = new WeakSet<Electron.Session>()
  private launches = new Map<string, number>()
  constructor(
    private directory: string,
    private host: Host,
  ) {
    ipcMain.handle('terminal:host-state', event => this.host.state(this.sender(event).id))
    ipcMain.handle('terminal:state', (event, value: unknown) => {
      const tab = this.sender(event)
      if (!value || typeof value !== 'object') return
      const state = value as TerminalTabState
      if (
        typeof state.title !== 'string' ||
        state.title.length > 512 ||
        !['connecting', 'connected', 'reconnecting', 'closed'].includes(state.connection) ||
        typeof state.attention !== 'boolean' ||
        typeof state.hasDraft !== 'boolean'
      )
        return
      tab.state = {
        title: cleanTitle(state.title),
        connection: state.connection,
        attention: state.attention,
        hasDraft: state.hasDraft,
      }
      tab.error = null
      this.host.changed()
    })
    ipcMain.handle('terminal:open-external', async (event, value: unknown) => {
      const tab = this.sender(event)
      const url = browserUrl({ url: value })
      if (Date.now() - tab.externalAt < 500) return false
      tab.externalAt = Date.now()
      try {
        await shell.openExternal(url)
        return true
      } catch {
        return false
      }
    })
    ipcMain.handle('terminal:copy', (event, value: unknown) => {
      const tab = this.sender(event)
      if (
        !this.host.focused(tab.id) ||
        !tab.view.webContents.isFocused() ||
        typeof value !== 'string' ||
        Buffer.byteLength(value, 'utf8') > 1024 * 1024
      )
        return false
      clipboard.writeText(value)
      return true
    })
    ipcMain.handle('terminal:paste', event => {
      const tab = this.sender(event)
      if (!this.host.focused(tab.id) || !tab.view.webContents.isFocused()) return false
      tab.view.webContents.paste()
      return true
    })
    ipcMain.handle('terminal:bell', (event, name: unknown) => {
      const tab = this.sender(event)
      if (typeof name !== 'string' || name.length > 512 || this.host.focused(tab.id)) return false
      tab.state.attention = true
      this.host.changed()
      if (!Notification.isSupported()) return false
      if (tab.notification) return true
      const notification = new Notification({
        title: 'Outpost · Terminal bell',
        body: `${cleanTitle(name)} rang a bell`,
        icon: join(this.directory, 'outpost.png'),
        silent: true,
      })
      tab.notification = notification
      notification.on('click', () => this.host.activate(tab.id))
      notification.on('close', () => {
        if (tab.notification === notification) tab.notification = null
      })
      notification.on('failed', () => this.dismiss(tab))
      notification.show()
      return true
    })
    ipcMain.handle('terminal:dismiss-bell', event => this.dismiss(this.sender(event)))
    ipcMain.handle('terminal:close', event => this.host.close(this.sender(event).id))
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
    const tab = this.tabs.get(event.sender.id)
    if (!tab || event.senderFrame !== event.sender.mainFrame || !this.allowed(event.senderFrame.url, tab.origin))
      throw new Error('Desktop action is unavailable in this page.')
    return tab
  }
  dismiss(tab: TerminalTab) {
    const notification = tab.notification
    tab.notification = null
    if (notification) {
      notification.removeAllListeners()
      notification.close()
    }
  }
  hostState() {
    for (const tab of this.tabs.values())
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.send('terminal:host-state', this.host.state(tab.id))
  }
  dispose(id: number) {
    const tab = this.tabs.get(id)
    if (!tab) return
    this.dismiss(tab)
    this.tabs.delete(id)
    this.launches.delete(tab.launchKey)
    const window = this.host.window()
    if (window && !window.isDestroyed()) window.contentView.removeChildView(tab.view)
    // Native child views are not destroyed with the BrowserWindow automatically.
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false })
    this.host.removed(id)
  }
  open(launch: DesktopLaunch) {
    const launchKey = createHash('sha256').update(launch.token).digest('hex')
    const existing = this.launches.get(launchKey)
    if (existing !== undefined) return { tab: this.tabs.get(existing)!, created: false }
    if (this.tabs.size >= 32) throw new Error('Close a tab before opening another session (32 tabs maximum).')
    const partition = 'outpost-' + createHash('sha256').update(launch.server).digest('hex')
    const browserSession = session.fromPartition(partition, { cache: false })
    if (!this.sessions.has(browserSession)) {
      this.sessions.add(browserSession)
      browserSession.setPermissionCheckHandler(() => false)
      browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      browserSession.on('will-download', event => event.preventDefault())
    }
    const view = new WebContentsView({
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
    view.setBackgroundColor('#0f172a')
    const contents = view.webContents
    const tab: TerminalTab = {
      id: contents.id,
      view,
      origin: launch.server,
      label: null,
      error: null,
      notification: null,
      externalAt: 0,
      launchKey,
      state: { title: cleanTitle(launch.title), connection: 'connecting', attention: false, hasDraft: false },
    }
    this.tabs.set(tab.id, tab)
    this.launches.set(launchKey, tab.id)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('will-frame-navigate', event => {
      if (!event.isMainFrame || !this.allowed(event.url, tab.origin)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (!this.allowed(url, tab.origin)) event.preventDefault()
    })
    contents.on('focus', () => {
      if (view.getVisible() && this.host.window()?.isFocused() && !this.host.focused(tab.id)) this.host.activate(tab.id)
    })
    contents.on('context-menu', (_event, params) => {
      // TerminalView owns the terminal menu in both clients and prevents the
      // native event. Keep OS editing actions for the message box and other fields.
      if (!params.isEditable) return
      const menu = Menu.buildFromTemplate([
        { label: 'Undo', enabled: params.editFlags.canUndo, click: () => contents.undo() },
        { label: 'Redo', enabled: params.editFlags.canRedo, click: () => contents.redo() },
        { type: 'separator' },
        { label: 'Cut', enabled: params.editFlags.canCut, click: () => contents.cut() },
        { label: 'Copy', enabled: params.editFlags.canCopy, click: () => contents.copy() },
        { label: 'Paste', enabled: params.editFlags.canPaste, click: () => contents.paste() },
        { type: 'separator' },
        { label: 'Select all', enabled: params.editFlags.canSelectAll, click: () => contents.selectAll() },
      ])
      const window = this.host.window()
      if (window) menu.popup({ window })
    })
    contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (!mainFrame || code === -3) return
      tab.error = 'Could not load the terminal. Check the server connection, then reload or open a new connection.'
      tab.state.connection = 'closed'
      this.host.changed()
    })
    contents.on('render-process-gone', () => {
      tab.error = 'This terminal stopped responding. Reload it to reconnect. Your remote session keeps running.'
      tab.state.connection = 'closed'
      this.host.changed()
    })
    contents.on('destroyed', () => this.dispose(tab.id))
    // The shared entry erases the fragment before rendering. No credentials reach the local chrome.
    void contents.loadURL(`${launch.server}${pagePaths.desktopTerminal}#token=${launch.token}`).catch(() => {})
    return { tab, created: true }
  }
}
