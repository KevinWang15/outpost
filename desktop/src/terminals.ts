import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LocalTerminal } from './local-terminal'
import type { ShellProfile } from './shell-profiles'
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
  type IpcMainEvent,
  type WebContents,
} from 'electron'
import type { DesktopLaunch, TerminalHostState, TerminalPaneState } from '../../shared/desktop'
import { parseSessionActivity } from '../../shared/activity'
import { pagePaths } from '../../shared/pages'
import { browserUrl } from '../../shared/signals'
import { attachWorkspaceShortcuts, type PaneAction } from './workspace-shortcuts'
import { PaneAppearance } from './pane-appearance'
import { remoteSessionId, validResumeToken, type RecentSession } from './recent-sessions'

export interface TerminalPane {
  id: number
  view: WebContentsView
  appearance: PaneAppearance
  origin: string
  state: TerminalPaneState
  error: string | null
  notification: Notification | null
  externalAt: number
  connection:
    | {
        kind: 'remote'
        launchKey: string
        sessionKey: string
        token: string
        remember: boolean
        pendingLaunches: Set<string>
        url: string
      }
    | { kind: 'local'; terminal: LocalTerminal }
  interfaceReady: boolean
  interfaceTimer?: ReturnType<typeof setTimeout>
}
interface Host {
  window(id: number): BrowserWindow | null
  focused(id: number): boolean
  activate(id: number): void
  focus(id: number): void
  cycle(id: number, delta: 1 | -1): void
  cancelDrag(): boolean
  paneAction(id: number, action: PaneAction): void
  close(id: number): Promise<void>
  removing(id: number): void
  removed(id: number): void
  changed(id: number): void
  state(id: number): TerminalHostState
  remember(session: RecentSession): Promise<void>
}
const cleanTitle = (value: string) =>
  [...value]
    .filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join('')
    .slice(0, 512)

/** Owns isolated terminal contents and their narrow native capabilities. */
export class TerminalPanes {
  private live = new Map<number, TerminalPane>()
  get panes(): ReadonlyMap<number, TerminalPane> {
    return this.live
  }
  private sessions = new WeakSet<Electron.Session>()
  private sessionPanes = new Map<string, number>()
  private hostStates = new WeakMap<WebContents, TerminalHostState>()
  private cleanup = new Set<Promise<void>>()
  constructor(
    private directory: string,
    private host: Host,
  ) {
    ipcMain.handle('terminal:host-state', event => this.host.state(this.sender(event).id))
    ipcMain.handle('terminal:ticket', event => {
      const connection = this.sender(event).connection
      return connection.kind === 'remote' ? connection.token : null
    })
    ipcMain.handle('terminal:save-resume', (event, token: unknown, title: unknown) => {
      const pane = this.sender(event)
      const connection = pane.connection
      if (connection.kind !== 'remote' || !validResumeToken(token) || typeof title !== 'string' || title.length > 512)
        throw new Error('Invalid session reconnect credential.')
      connection.token = token
      return this.remember(pane, cleanTitle(title))
    })
    ipcMain.handle('terminal:pending-launches', event => {
      const connection = this.sender(event).connection
      return connection.kind === 'remote' ? [...connection.pendingLaunches] : []
    })
    ipcMain.handle('terminal:launch-handled', (event, token: unknown) => {
      const connection = this.sender(event).connection
      if (connection.kind === 'remote' && typeof token === 'string') connection.pendingLaunches.delete(token)
    })
    ipcMain.handle('terminal:state', (event, value: unknown) => {
      const pane = this.sender(event)
      if (!value || typeof value !== 'object') return
      const state = value as TerminalPaneState
      const activity = parseSessionActivity(state.activity)
      if (
        typeof state.title !== 'string' ||
        state.title.length > 512 ||
        !['connecting', 'connected', 'reconnecting', 'closed'].includes(state.connection) ||
        (state.activity !== null && activity === null) ||
        typeof state.attention !== 'boolean' ||
        typeof state.hasDraft !== 'boolean'
      )
        return
      // The renderer owns bell state, including acknowledgement on activation.
      // Native notification handlers must not race these ordered reports.
      pane.state = {
        title: cleanTitle(state.title),
        connection: state.connection,
        activity: state.connection === 'connected' ? activity : null,
        attention: state.attention,
        hasDraft: state.hasDraft,
      }
      clearTimeout(pane.interfaceTimer)
      pane.interfaceReady = true
      pane.error = null
      this.host.changed(pane.id)
    })
    ipcMain.handle('terminal:open-external', async (event, value: unknown) => {
      const pane = this.sender(event)
      const url = browserUrl({ url: value })
      if (Date.now() - pane.externalAt < 500) return false
      pane.externalAt = Date.now()
      try {
        await shell.openExternal(url)
        return true
      } catch {
        return false
      }
    })
    ipcMain.handle('terminal:copy', (event, value: unknown) => {
      const pane = this.sender(event)
      if (
        !this.host.focused(pane.id) ||
        !pane.view.webContents.isFocused() ||
        typeof value !== 'string' ||
        Buffer.byteLength(value, 'utf8') > 1024 * 1024
      )
        return false
      clipboard.writeText(value)
      return true
    })
    ipcMain.handle('terminal:paste', event => {
      const pane = this.sender(event)
      if (!this.host.focused(pane.id) || !pane.view.webContents.isFocused()) return false
      pane.view.webContents.paste()
      return true
    })
    ipcMain.handle('terminal:bell', (event, name: unknown) => {
      const pane = this.sender(event)
      if (typeof name !== 'string' || name.length > 512 || this.host.focused(pane.id)) return false
      if (!Notification.isSupported()) return false
      if (pane.notification) return true
      const notification = new Notification({
        title: 'Outpost · Terminal bell',
        body: `${cleanTitle(name)} rang a bell`,
        icon: join(this.directory, 'outpost.png'),
        silent: true,
      })
      pane.notification = notification
      notification.on('click', () => this.host.activate(pane.id))
      notification.on('close', () => {
        if (pane.notification === notification) pane.notification = null
      })
      notification.on('failed', () => this.dismiss(pane))
      notification.show()
      return true
    })
    ipcMain.handle('terminal:dismiss-bell', event => this.dismiss(this.sender(event)))
    ipcMain.handle('terminal:close', event => this.host.close(this.sender(event).id))
    ipcMain.handle('local:start', (event, generation, cols, rows) => this.local(event).start(generation, cols, rows))
    ipcMain.handle('local:write', (event, generation, data) => this.local(event).write(generation, data))
    ipcMain.handle('local:resize', (event, generation, cols, rows) => this.local(event).resize(generation, cols, rows))
    ipcMain.handle('local:stop', (event, generation) => this.local(event).stop(generation))
    ipcMain.handle('local:image', (event, generation, data, mediaType) =>
      this.local(event).pasteImage(generation, data, mediaType),
    )
    ipcMain.on('local:ack', (event, generation, length) => {
      try {
        this.local(event).acknowledge(generation, length)
      } catch {
        /* Ignore obsolete or unauthorized acknowledgements. */
      }
    })
  }

  private get localPage() {
    return pathToFileURL(join(this.directory, 'local-terminal/index.html')).href
  }

  private allowed(value: string, pane: TerminalPane) {
    try {
      const url = new URL(value)
      if (pane.connection.kind === 'local') return url.href === this.localPage
      return url.origin === pane.origin && url.pathname === pagePaths.desktopTerminal && !url.search
    } catch {
      return false
    }
  }
  private sender(event: IpcMainInvokeEvent | IpcMainEvent) {
    const pane = this.live.get(event.sender.id)
    if (
      !pane ||
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame ||
      !this.allowed(event.senderFrame.url, pane)
    )
      throw new Error('Desktop action is unavailable in this page.')
    return pane
  }
  private local(event: IpcMainInvokeEvent | IpcMainEvent) {
    const connection = this.sender(event).connection
    if (connection.kind !== 'local') throw new Error('Local shell access is unavailable to server pages.')
    return connection.terminal
  }

  dismiss(pane: TerminalPane) {
    const notification = pane.notification
    pane.notification = null
    if (notification) {
      notification.removeAllListeners()
      notification.close()
    }
  }
  async remember(pane: TerminalPane, title = pane.state.title) {
    const connection = pane.connection
    if (connection.kind !== 'remote' || !connection.remember) return
    await this.host.remember({
      id: remoteSessionId(pane.origin, connection.sessionKey),
      server: pane.origin,
      sessionKey: connection.sessionKey,
      token: connection.token,
      title,
      lastConnectedAt: Date.now(),
    })
  }
  hostState(ids: Iterable<number>) {
    for (const id of ids) {
      const pane = this.live.get(id)
      if (!pane || pane.view.webContents.isDestroyed()) continue
      const contents = pane.view.webContents
      const next = this.host.state(pane.id)
      const previous = this.hostStates.get(contents)
      // Activity refreshes repaint chrome; focus and preferences change separately.
      if (previous?.focused === next.focused && previous.fontSize === next.fontSize && previous.sound === next.sound)
        continue
      this.hostStates.set(contents, next)
      contents.send('terminal:host-state', next)
    }
  }
  resume() {
    // Wake every remote pane, including panes in minimized/background windows.
    // Local shells keep their PTY and require no reconnection.
    for (const pane of this.live.values()) {
      if (pane.connection.kind === 'remote' && !pane.view.webContents.isDestroyed())
        pane.view.webContents.send('terminal:command', 'resume')
    }
  }
  dispose(id: number) {
    const pane = this.live.get(id)
    if (!pane) return
    // A hover transfer must be restored before destroying its native view.
    this.host.removing(id)
    this.dismiss(pane)
    clearTimeout(pane.interfaceTimer)
    this.live.delete(id)
    if (pane.connection.kind === 'remote')
      this.sessionPanes.delete(remoteSessionId(pane.origin, pane.connection.sessionKey))
    else {
      const cleanup = pane.connection.terminal.dispose()
      this.cleanup.add(cleanup)
      void cleanup.finally(() => this.cleanup.delete(cleanup))
    }
    const window = this.host.window(pane.id)
    if (window && !window.isDestroyed()) window.contentView.removeChildView(pane.view)
    // Native child views are not destroyed with the BrowserWindow automatically.
    if (!pane.view.webContents.isDestroyed()) pane.view.webContents.close({ waitForBeforeUnload: false })
    this.host.removed(id)
  }
  reloadPane(id: number) {
    const pane = this.live.get(id)
    if (!pane || pane.view.webContents.isDestroyed()) return
    pane.error = null
    pane.state = { ...pane.state, hasDraft: false, connection: 'connecting', activity: null }
    pane.view.webContents.reload()
    this.host.changed(id)
  }
  async flushCleanup() {
    await Promise.all(this.cleanup)
  }
  open(launch: DesktopLaunch) {
    const launchKey = createHash('sha256').update(launch.token).digest('hex')
    const sessionKey = remoteSessionId(launch.server, launch.sessionKey)
    const existing = this.sessionPanes.get(sessionKey)
    if (existing !== undefined) {
      const pane = this.live.get(existing)!
      const connection = pane.connection
      if (connection.kind !== 'remote') throw new Error('Invalid remote pane.')
      connection.remember = true
      if (connection.launchKey !== launchKey) {
        if (connection.pendingLaunches.size >= 16)
          throw new Error('This terminal is still opening. Try Connect again shortly.')
        connection.launchKey = launchKey
        // A healthy pane consumes this launch via activate; keep its reusable
        // resume credential for reloads instead of the single-use launch ticket.
        if (pane.error) {
          // Recover a failed page in the same pane. A healthy renderer handles
          // launches through its existing socket and retains its composer draft.
          connection.pendingLaunches.clear()
          connection.token = launch.token
          pane.error = null
          pane.state = { ...pane.state, connection: 'connecting', activity: null, hasDraft: false }
          void pane.view.webContents.loadURL(connection.url).catch(() => {})
        } else {
          connection.pendingLaunches.add(launch.token)
          pane.view.webContents.send('terminal:launch', launch.token)
        }
      }
      return { pane, created: false }
    }
    return this.createRemote(launch, launchKey)
  }

  openRecent(entry: RecentSession) {
    const existing = this.sessionPanes.get(entry.id)
    // A saved resume credential must never enter the fresh-launch activation path.
    if (existing !== undefined) {
      const pane = this.live.get(existing)!
      if (pane.connection.kind === 'remote') pane.connection.remember = true
      return { pane, created: false }
    }
    return this.createRemote(entry, '')
  }

  private createRemote(entry: Pick<DesktopLaunch, 'server' | 'sessionKey' | 'token' | 'title'>, launchKey: string) {
    const sessionKey = remoteSessionId(entry.server, entry.sessionKey)
    const pane = this.create(entry.server, entry.title, {
      kind: 'remote',
      launchKey,
      sessionKey: entry.sessionKey,
      token: entry.token,
      remember: true,
      pendingLaunches: new Set(),
      url: `${entry.server}${pagePaths.desktopTerminal}`,
    })
    this.sessionPanes.set(sessionKey, pane.id)
    return { pane, created: true }
  }

  forgetRecent(id?: string) {
    for (const pane of this.live.values()) {
      const connection = pane.connection
      if (
        connection.kind === 'remote' &&
        (id === undefined || remoteSessionId(pane.origin, connection.sessionKey) === id)
      )
        connection.remember = false
    }
  }

  openLocal(profile: ShellProfile) {
    const terminal = new LocalTerminal(profile, event => {
      if (!pane.view.webContents.isDestroyed()) pane.view.webContents.send('local:event', event)
    })
    const pane = this.create('This computer', `${profile.name} · Local`, { kind: 'local', terminal })
    return pane
  }

  private create(origin: string, title: string, connection: TerminalPane['connection']) {
    if (this.live.size >= 32) throw new Error('Close a pane before opening another session (32 panes maximum).')
    const partition =
      connection.kind === 'local' ? 'outpost-local' : 'outpost-' + createHash('sha256').update(origin).digest('hex')
    const browserSession = session.fromPartition(partition, { cache: false })
    if (!this.sessions.has(browserSession)) {
      this.sessions.add(browserSession)
      browserSession.setPermissionCheckHandler(() => false)
      browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      browserSession.on('will-download', event => event.preventDefault())
    }
    const view = new WebContentsView({
      webPreferences: {
        preload: join(this.directory, connection.kind === 'local' ? 'local-preload.cjs' : 'preload.cjs'),
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
    // Attaching a new native child must not focus it before layout selects it.
    view.setVisible(false)
    view.setBackgroundColor('#0f172a')
    const contents = view.webContents
    const pane: TerminalPane = {
      id: contents.id,
      view,
      appearance: new PaneAppearance(contents),
      origin,
      error: null,
      notification: null,
      externalAt: 0,
      connection,
      interfaceReady: false,
      state: {
        title: cleanTitle(title),
        connection: 'connecting',
        activity: null,
        attention: false,
        hasDraft: false,
      },
    }
    this.live.set(pane.id, pane)
    attachWorkspaceShortcuts(contents, {
      cycle: delta => this.host.cycle(pane.id, delta),
      cancelDrag: () => this.host.cancelDrag(),
      pane: action => this.host.paneAction(pane.id, action),
    })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.on('will-frame-navigate', event => {
      if (!event.isMainFrame || !this.allowed(event.url, pane)) event.preventDefault()
    })
    contents.on('will-redirect', (event, url) => {
      if (!this.allowed(url, pane)) event.preventDefault()
    })
    contents.on('focus', () => {
      if (contents.isFocused() && this.host.window(pane.id)?.isFocused()) this.host.focus(pane.id)
    })
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) {
        if (connection.kind === 'local') connection.terminal.stop()
        this.hostStates.delete(contents)
        clearTimeout(pane.interfaceTimer)
        pane.interfaceReady = false
      }
    })
    contents.on('did-finish-load', () => {
      // Old server pages silently ignore a newer preload. Make that failure
      // visible; a late reportState clears the error if loading was merely slow.
      clearTimeout(pane.interfaceTimer)
      if (pane.interfaceReady) return
      pane.interfaceTimer = setTimeout(() => {
        if (pane.interfaceReady || pane.error) return
        pane.error =
          'The terminal interface did not initialize. Update Outpost Desktop and your server together, then reload.'
        pane.state.connection = 'closed'
        pane.state.activity = null
        this.host.changed(pane.id)
      }, 15_000)
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
      const window = this.host.window(pane.id)
      if (window) menu.popup({ window })
    })
    contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (!mainFrame || code === -3) return
      pane.error =
        connection.kind === 'local'
          ? 'Could not load the local terminal. Reinstall Outpost Desktop or open a new pane.'
          : 'Could not load the terminal. Check the server connection, then reload or open a new connection.'
      pane.state.connection = 'closed'
      pane.state.activity = null
      this.host.changed(pane.id)
    })
    contents.on('render-process-gone', () => {
      if (connection.kind === 'local') connection.terminal.stop()
      pane.error =
        connection.kind === 'local'
          ? 'The local terminal stopped responding. Reload to start a new shell.'
          : 'This terminal stopped responding. Reload it to reconnect. Your remote session keeps running.'
      pane.state.connection = 'closed'
      pane.state.activity = null
      this.host.changed(pane.id)
    })
    contents.on('destroyed', () => this.dispose(pane.id))
    // The isolated terminal requests its own credential through the preload.
    void contents.loadURL(connection.kind === 'local' ? this.localPage : connection.url).catch(() => {})
    return pane
  }
}
