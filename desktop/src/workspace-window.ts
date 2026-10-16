import { app, BrowserWindow, dialog, Menu, shell, type IpcMainInvokeEvent, type Point } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { desktopOrigin, type TerminalCommand, type TerminalPreferences } from '../../shared/desktop'
import { paneLayout, splitRatio, TabLayout, type TabLayoutState } from './layout'
import { defaultPreferences, Preferences, validPreferences } from './preferences'
import { TrustedServers } from './store'
import { TerminalTabs, type TerminalTab } from './terminals'
import { attachTabShortcuts } from './tab-shortcuts'
import { checkUpdates } from './updates'
import { keepsTabDrag, workspaceCommand } from './workspace-commands'
import type { ShellProfile } from './shell-profiles'
import type { RecentSessionSummary } from './recent-sessions'
import {
  tabBarHeight,
  type SplitDirection,
  type WorkspacePanel,
  type WorkspaceSnapshot,
  type TabGeometry,
  type TabDragState,
} from './workspace-api'

export interface WorkspaceHost {
  shells(): ShellProfile[]
  newLocal(source: WorkspaceWindow, profile?: string): void
  recentSessions(): RecentSessionSummary[]
  openRecent(source: WorkspaceWindow, id: string): Promise<void>
  removeRecent(id: string): Promise<void>
  clearRecent(): Promise<void>
  forgetRecents(): Promise<void>
  quitting(): boolean
  focused(window: WorkspaceWindow): void
  closed(window: WorkspaceWindow): void
  changed(): void
  move(id: number, destination: number | null): void
  destinations(source: WorkspaceWindow): { id: number; label: string }[]
  dragStart(source: WorkspaceWindow, id: number): void
  dragEnd(source: WorkspaceWindow, cancel: boolean): void
  dragCancel(window: WorkspaceWindow): void
  dragState(window: WorkspaceWindow): TabDragState | null
}

/** One window owns layout and chrome; the application owns terminal lifetimes. */
export class WorkspaceWindow {
  private window: BrowserWindow | null = null
  private layout = new TabLayout()
  private geometry: TabGeometry | null = null
  private closing = new Set<number>()
  private confirmingWindow = false
  private reportingError = false
  private allowWindowClose = false
  private presenting = false
  constructor(
    private directory: string,
    private trusted: TrustedServers,
    private preferences: Preferences,
    private trust: (origin: string) => Promise<boolean>,
    private terminals: TerminalTabs,
    private host: WorkspaceHost,
  ) {}
  invoke(event: IpcMainInvokeEvent, name: unknown, values: unknown[]) {
    const url = pathToFileURL(join(this.directory, 'workspace.html')).href
    if (
      !this.window ||
      event.sender !== this.window.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame.url !== url
    )
      throw new Error('This action is only available in the Outpost workspace.')
    const command = workspaceCommand(name, values)
    if (!keepsTabDrag(command.name)) this.host.dragCancel(this)
    switch (command.name) {
      case 'state':
        return this.snapshot()
      case 'newLocal':
        return this.host.newLocal(this, command.args[0])
      case 'shellMenu':
        return this.shellMenu()
      case 'activate':
        return this.activate(command.args[0], command.args[1] !== false)
      case 'close':
        return this.close(command.args[0])
      case 'reorder':
        this.layout.move(...command.args)
        return this.render()
      case 'rename': {
        const [id, label] = command.args
        const tab = this.tab(id)
        if (tab) {
          tab.label = label.trim() || null
          this.panel(null)
        }
        return
      }
      case 'panel': {
        const value = command.args[0]
        if (value === null || typeof value === 'string' || this.has(value.rename)) this.panel(value)
        return
      }
      case 'pair':
        this.layout.pair(command.args[0])
        this.render()
        return this.focusTerminal()
      case 'split':
        return this.split(command.args[0])
      case 'ratio':
        if (this.layout.split) {
          this.layout.split.ratio = Math.max(0.2, Math.min(0.8, command.args[0]))
          this.render()
        }
        return
      case 'contextMenu':
        return this.contextMenu(command.args[0])
      case 'reload':
        return this.reload(command.args[0])
      case 'openServer':
        return this.openServer(command.args[0])
      case 'forgetServer':
        return this.forgetServer(command.args[0])
      case 'openRecent':
        return this.host.openRecent(this, command.args[0])
      case 'removeRecent':
        return this.host.removeRecent(command.args[0])
      case 'clearRecent':
        return this.host.clearRecent()
      case 'preferences': {
        const [value, shell] = command.args
        if (!this.host.shells().some(profile => profile.id === shell))
          throw new Error('Choose an available local shell.')
        return this.setPreferences(value, shell)
      }
      case 'checkUpdates':
        return checkUpdates()
      case 'reportError':
        return this.reportError(command.args[0])
      case 'tabGeometry':
        if (command.args[0].tabs.every(tab => this.has(tab.id))) this.geometry = command.args[0]
        return
      case 'dragStart':
        return this.host.dragStart(this, command.args[0])
      case 'dragEnd':
        return this.host.dragEnd(this, command.args[0])
      default: {
        const missing: never = command
        throw new Error(`Unhandled workspace action: ${String(missing)}`)
      }
    }
  }

  get browserWindow() {
    return this.window
  }
  get ids() {
    return [...this.layout.ids]
  }
  has(id: number) {
    return this.layout.ids.includes(id)
  }
  private tab(id: number) {
    return this.has(id) ? this.terminals.tabs.get(id) : undefined
  }
  get hasTabs() {
    return this.layout.ids.length > 0
  }
  focused(id: number) {
    return Boolean(
      this.window?.isFocused() &&
      !this.host.dragState(this) &&
      this.layout.panel === null &&
      this.layout.active === id &&
      !this.terminals.tabs.get(id)?.error,
    )
  }
  focus(id: number) {
    if (
      !this.host.dragState(this) &&
      !this.presenting &&
      this.layout.visible().includes(id) &&
      this.layout.active !== id
    )
      this.activate(id)
  }
  private snapshot(): WorkspaceSnapshot {
    return {
      version: app.getVersion(),
      platform: process.platform,
      active: this.layout.active,
      split: this.layout.split,
      panel: this.layout.panel,
      servers: this.trusted.list(),
      recentSessions: this.host.recentSessions(),
      preferences: this.preferences.value,
      shells: this.host.shells().map(({ id, name }) => ({ id, name })),
      defaultShell:
        this.host.shells().find(profile => profile.id === this.preferences.localShell)?.id ?? this.host.shells()[0].id,
      drag: this.host.dragState(this),
      tabs: this.layout.ids.flatMap(id => {
        const tab = this.terminals.tabs.get(id)
        return tab
          ? [
              {
                ...tab.state,
                id,
                kind: tab.connection.kind,
                origin: tab.origin,
                label: tab.label || tab.state.title,
                error: tab.error,
              },
            ]
          : []
      }),
    }
  }
  ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window
    this.allowWindowClose = false
    const window = new BrowserWindow({
      title: 'Outpost',
      width: 1280,
      height: 840,
      minWidth: 640,
      minHeight: 420,
      backgroundColor: '#0b1220',
      // The tab strip occupies the title bar; Electron retains native window
      // controls and exposes their safe area to the bundled workspace renderer.
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        height: tabBarHeight,
        color: '#0b1220',
        symbolColor: '#dbe5f4',
      },
      icon: join(this.directory, 'outpost.png'),
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: join(this.directory, 'workspace-preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
      },
    })
    this.window = window
    attachTabShortcuts(window.webContents, delta => {
      this.host.dragCancel(this)
      this.cycle(delta)
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('did-finish-load', () => this.render())
    window.webContents.on('did-start-loading', () => this.host.dragCancel(this))
    window.webContents.on('render-process-gone', () => {
      this.host.dragCancel(this)
      // Terminal views survive a local chrome crash; reload only the chrome.
      if (!window.isDestroyed()) void window.loadFile(join(this.directory, 'workspace.html')).catch(() => {})
    })
    window.on('resize', () => this.render())
    window.on('hide', () => this.host.dragCancel(this))
    window.on('minimize', () => this.host.dragCancel(this))
    window.on('focus', () => {
      this.host.focused(this)
      this.terminals.hostState(this.ids)
    })
    window.on('blur', () => {
      this.host.dragCancel(this)
      this.terminals.hostState(this.ids)
    })
    window.on('close', event => {
      this.host.dragCancel(this)
      if (this.allowWindowClose || this.host.quitting() || !this.hasTabs) return
      event.preventDefault()
      if (this.confirmingWindow) return
      this.confirmingWindow = true
      void this.confirmWindow()
        .then(confirmed => {
          if (confirmed && !window.isDestroyed()) {
            this.allowWindowClose = true
            window.close()
          }
        })
        .finally(() => {
          this.confirmingWindow = false
        })
    })
    window.on('closed', () => {
      this.window = null
      for (const id of this.ids) this.terminals.dispose(id)
      this.host.closed(this)
    })
    window.once('ready-to-show', () => {
      if (!window.isVisible()) window.show()
      if (window.isFocused()) this.focusTerminal()
    })
    void window.loadFile(join(this.directory, 'workspace.html')).catch(() => {})
    return window
  }
  show() {
    const window = this.ensureWindow()
    this.presenting = true
    try {
      // Hide the old terminal before restoring native focus to the window.
      this.render()
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
      this.focusTerminal()
    } finally {
      this.presenting = false
    }
  }
  add(tab: TerminalTab, before: number | null = null) {
    const window = this.ensureWindow()
    window.contentView.addChildView(tab.view)
    this.layout.add(tab.id)
    this.layout.move(tab.id, before)
  }
  captureLayout() {
    return this.layout.snapshot()
  }
  restoreLayout(state: TabLayoutState) {
    this.layout.restore(state)
    for (const id of this.ids) {
      const tab = this.terminals.tabs.get(id)
      if (!tab || tab.view.webContents.isDestroyed()) this.layout.remove(id)
    }
    this.geometry = null
    this.render()
  }
  release(id: number) {
    const tab = this.terminals.tabs.get(id)
    if (!tab) return
    if (!tab.view.webContents.isDestroyed()) tab.view.setVisible(false)
    this.window?.contentView.removeChildView(tab.view)
    this.remove(id)
  }
  remove(id: number) {
    this.layout.remove(id)
    this.geometry = null
    this.render()
  }
  reorder(id: number, before: number | null) {
    this.layout.move(id, before)
    this.activate(id)
  }
  placeTab(id: number, before: number | null) {
    this.layout.move(id, before)
  }
  closeEmpty() {
    if (!this.hasTabs) this.window?.close()
  }
  activate(id: number, focusTerminal = true) {
    if (!this.has(id)) return
    this.layout.activate(id)
    if (focusTerminal) this.show()
    else this.render()
  }
  panel(panel: WorkspacePanel) {
    this.layout.panel = panel
    this.show()
  }
  private focusTerminal() {
    const tab = this.layout.active === null ? undefined : this.terminals.tabs.get(this.layout.active)
    if (this.layout.panel !== null || !tab || tab.error) this.window?.webContents.focus()
    else {
      tab.view.webContents.focus()
      tab.view.webContents.send('terminal:command', 'focus')
    }
  }
  restoreFocus() {
    if (this.window?.isFocused()) this.focusTerminal()
  }
  private async reportError(message: string) {
    const window = this.window
    if (!window || window.isDestroyed() || this.reportingError || typeof message !== 'string' || !message.trim()) return
    this.reportingError = true
    try {
      // Native terminal views sit above the workspace DOM. A native dialog
      // keeps errors visible without reserving a permanent strip of the window.
      await dialog.showMessageBox(window, {
        type: 'error',
        title: 'Outpost',
        message: 'Could not complete this action',
        detail: message.slice(0, 4096),
        buttons: ['OK'],
        noLink: true,
      })
    } finally {
      this.reportingError = false
      this.restoreFocus()
    }
  }
  render() {
    const window = this.window
    if (!window || window.isDestroyed()) return
    const [width, height] = window.getContentSize()
    const area = { x: 0, y: tabBarHeight, width, height: Math.max(0, height - tabBarHeight) }
    const visible = this.layout.visible()
    if (this.layout.split) this.layout.split.ratio = splitRatio(area.width, area.height, this.layout.split)
    const geometry = paneLayout(area.width, area.height, this.layout.split)
    for (const id of this.layout.ids) {
      const tab = this.terminals.tabs.get(id)!
      const shown = visible.includes(tab.id) && !tab.error
      if (shown) {
        const bounds = geometry.panes[visible.indexOf(tab.id)]
        const next = { ...bounds, y: bounds.y + tabBarHeight }
        const previous = tab.view.getBounds()
        if (
          next.x !== previous.x ||
          next.y !== previous.y ||
          next.width !== previous.width ||
          next.height !== previous.height
        )
          tab.view.setBounds(next)
      }
      if (tab.view.getVisible() !== shown) tab.view.setVisible(shown)
    }
    const active = this.layout.active === null ? undefined : this.terminals.tabs.get(this.layout.active)
    window.setTitle(active ? `${active.label || active.state.title} · Outpost` : 'Outpost')
    window.webContents.send('workspace:state', this.snapshot())
    this.terminals.hostState(this.ids)
  }
  cycle(delta: number) {
    this.layout.cycle(delta)
    this.render()
    this.focusTerminal()
  }
  select(index: number) {
    const id = index === 8 ? this.layout.ids.at(-1) : this.layout.ids[index]
    if (id !== undefined) this.activate(id)
  }
  split(direction: SplitDirection | null) {
    if (direction !== null && direction !== 'columns' && direction !== 'rows') return
    if (direction !== null && this.layout.ids.length < 2) return this.panel('sessions')
    this.layout.direction(direction)
    this.layout.panel = null
    this.render()
    this.focusTerminal()
  }
  otherPane() {
    const id = this.layout.split?.ids.find(id => id !== this.layout.active)
    if (id !== undefined) this.activate(id)
  }
  command(command: Exclude<TerminalCommand, 'focus'>) {
    const tab = this.layout.active === null ? undefined : this.terminals.tabs.get(this.layout.active)
    if (this.layout.panel === null && tab && !tab.error) {
      if (command === 'find') tab.view.webContents.focus()
      tab.view.webContents.send('terminal:command', command)
    } else if (command === 'select-all') this.window?.webContents.selectAll()
  }
  edit(action: 'copy' | 'paste') {
    const tab = this.layout.active === null ? undefined : this.terminals.tabs.get(this.layout.active)
    const contents = this.layout.panel === null && tab && !tab.error ? tab.view.webContents : this.window?.webContents
    if (!contents || contents.isDestroyed()) return
    contents.focus()
    if (action === 'copy') contents.copy()
    else contents.paste()
  }
  async close(id = this.layout.active) {
    if (id === null || this.closing.has(id)) return
    const tab = this.tab(id)
    if (!tab) return
    this.closing.add(id)
    try {
      if (!(await this.confirmClose(tab))) return
      if (!this.has(id)) return
      this.terminals.dispose(id)
      this.focusTerminal()
    } finally {
      this.closing.delete(id)
    }
  }
  private async confirmClose(tab: TerminalTab) {
    if (!this.window) return false
    const detail =
      tab.connection.kind === 'remote'
        ? 'The remote session will keep running. You can reconnect through your Outpost server.'
        : tab.connection.terminal.running
          ? 'The local shell and its running processes will end. This terminal’s history will be discarded.'
          : 'This local shell has ended. Its terminal history will be discarded.'
    const result = await dialog.showMessageBox(this.window, {
      type: 'question',
      message: `Close “${tab.label || tab.state.title}”?`,
      detail: `${detail}${tab.state.hasDraft ? ' The unsent message will also be discarded.' : ''}`,
      buttons: ['Close tab', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    return result.response === 0
  }
  private async confirmDraft(tab: TerminalTab) {
    if (!this.window) return false
    const result = await dialog.showMessageBox(this.window, {
      type: 'question',
      message: 'Discard the unsent message?',
      detail: `${tab.label || tab.state.title} has a draft in its message box.${tab.connection.kind === 'remote' ? ' The remote session will keep running.' : ''}`,
      buttons: ['Discard draft', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    return result.response === 0
  }
  async reload(id = this.layout.active) {
    if (id === null) return
    const tab = this.tab(id)
    if (!tab || (tab.state.hasDraft && !(await this.confirmDraft(tab)))) return
    if (tab.connection.kind === 'local' && tab.connection.terminal.running && this.window) {
      const result = await dialog.showMessageBox(this.window, {
        type: 'question',
        message: 'Restart this local terminal?',
        detail: 'Reloading ends the current shell and starts a new one.',
        buttons: ['Restart shell', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      if (result.response !== 0) return
    }
    if (!this.has(id)) return
    tab.error = null
    tab.state = { ...tab.state, hasDraft: false, connection: 'connecting', activity: null }
    tab.view.webContents.reload()
    this.render()
  }
  private async confirmWindow() {
    if (!this.window) return true
    const draft = this.ids.some(id => this.tab(id)?.state.hasDraft)
    const result = await dialog.showMessageBox(this.window, {
      type: 'question',
      message: `Close ${this.layout.ids.length} terminal tabs?`,
      detail: `Local shells will end. Remote sessions keep running.${draft ? ' Unsent messages in the message boxes will be discarded.' : ''}`,
      buttons: ['Close tabs', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    return result.response === 0
  }
  private async openServer(value: unknown) {
    if (typeof value !== 'string') throw new Error('Enter an Outpost server URL.')
    const origin = desktopOrigin(value)
    if (!(await this.trust(origin))) return false
    this.host.changed()
    await shell.openExternal(origin)
    return true
  }
  private async forgetServer(value: unknown) {
    if (typeof value !== 'string' || !this.window) return
    const origin = desktopOrigin(value)
    const tabs = [...this.terminals.tabs.values()].filter(tab => tab.origin === origin)
    if (tabs.length) {
      const answer = await dialog.showMessageBox(this.window, {
        type: 'question',
        message: `Forget this server and close ${tabs.length} tabs across all windows?`,
        detail: `Remote sessions keep running. Unsent messages in these tabs will be discarded.\n${origin}`,
        buttons: ['Forget server', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      if (answer.response !== 0) return
    }
    await this.trusted.set(origin, false)
    for (const tab of tabs) this.terminals.dispose(tab.id)
    await this.host.forgetRecents()
    this.host.changed()
  }
  async setPreferences(value: TerminalPreferences, shell = this.preferences.localShell) {
    if (!validPreferences(value)) throw new Error('Use a font size between 10 and 28.')
    await this.preferences.set(value, shell)
    this.host.changed()
  }
  fontSize(delta: number | null) {
    const size =
      delta === null ? defaultPreferences.fontSize : Math.max(10, Math.min(28, this.preferences.value.fontSize + delta))
    void this.setPreferences({ ...this.preferences.value, fontSize: size }).catch(() => {})
  }
  private shellMenu() {
    if (!this.window) return
    Menu.buildFromTemplate(
      this.host.shells().map(profile => ({
        label: profile.name,
        click: () => {
          try {
            this.host.newLocal(this, profile.id)
          } catch (error) {
            void this.reportError((error as Error).message)
          }
        },
      })),
    ).popup({ window: this.window })
  }

  private contextMenu(id: number) {
    const tab = this.tab(id)
    if (!tab || !this.window) return
    Menu.buildFromTemplate([
      { label: 'Rename tab…', click: () => this.panel({ rename: id }) },
      { label: 'Move tab to new window', click: () => this.host.move(id, null) },
      {
        label: 'Move tab to window',
        enabled: this.host.destinations(this).length > 0,
        submenu: this.host.destinations(this).map(destination => ({
          label: destination.label,
          click: () => this.host.move(id, destination.id),
        })),
      },
      {
        label: 'Show beside current tab',
        enabled: this.layout.active !== id && this.layout.active !== null,
        click: () => {
          this.layout.pair(id)
          this.render()
          this.focusTerminal()
        },
      },
      { type: 'separator' },
      {
        label: 'Move tab left',
        enabled: this.layout.ids.indexOf(id) > 0,
        click: () => {
          this.layout.move(id, this.layout.ids[this.layout.ids.indexOf(id) - 1])
          this.render()
        },
      },
      {
        label: 'Move tab right',
        enabled: this.layout.ids.indexOf(id) < this.layout.ids.length - 1,
        click: () => {
          this.layout.move(this.layout.ids[this.layout.ids.indexOf(id) + 1], id)
          this.render()
        },
      },
      { type: 'separator' },
      {
        label: 'Reload terminal',
        click: () => {
          void this.reload(id)
        },
      },
      {
        label: 'Close tab',
        click: () => {
          void this.close(id)
        },
      },
    ]).popup({ window: this.window })
  }

  dropAt(point: Point, dragged?: number): number | null | undefined {
    if (!this.window || !this.geometry) return undefined
    const bounds = this.window.getContentBounds()
    const x = point.x - bounds.x,
      y = point.y - bounds.y
    if (y < 0 || y >= tabBarHeight || x < this.geometry.left || x >= this.geometry.right) return undefined
    // Keep a provisional insertion stable while the pointer is over it. Its
    // arrival changes flex widths; feeding those changes straight back into the
    // insertion decision makes a stationary pointer shuffle tabs indefinitely.
    const moving = this.geometry.tabs.find(tab => tab.id === dragged)
    if (moving && x >= moving.left && x < moving.right) return dragged
    return this.geometry.tabs.find(tab => x < (tab.left + tab.right) / 2)?.id ?? null
  }
  scrollAt(point: Point) {
    if (!this.window || !this.geometry) return 0
    const x = point.x - this.window.getContentBounds().x
    if (x < this.geometry.left || x > this.geometry.viewportRight) return 0
    return x < this.geometry.left + 24 ? -1 : x > this.geometry.viewportRight - 24 ? 1 : 0
  }
}
