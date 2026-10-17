import { app, BrowserWindow, dialog, Menu, screen, type IpcMainInvokeEvent, type Point } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TerminalCommand, TerminalPreferences } from '../../shared/desktop'
import { paneLayout, paneIds, tabBarHeight, WindowLayout } from './layout'
import { WorkspaceClose } from './workspace-close'
import { summarizeTabs } from './workspace-summary'
import { defaultPreferences, Preferences, validPreferences } from './preferences'
import { TerminalPanes, type TerminalPane } from './terminals'
import { attachWorkspaceShortcuts, type PaneAction } from './workspace-shortcuts'
import { checkUpdates } from './updates'
import { keepsWorkspaceDrag, workspaceCommand } from './workspace-commands'
import type { ShellProfile } from './shell-profiles'
import type { RecentSessionSummary } from './recent-sessions'
import type { ServerAccountsSnapshot } from './server-accounts-api'
import type { WorkspaceSnapshot, TabGeometry, WorkspaceDragState, PaneSummary } from './workspace-api'
import type {
  CloseScope,
  TabGroup,
  WindowLayoutState,
  SplitDirection,
  WorkspacePanel,
  WorkspaceItem,
  PanePlacement,
  SessionTarget,
} from './workspace-model'

export interface WorkspaceHost {
  shells(): ShellProfile[]
  newLocal(source: WorkspaceWindow, profile?: string, placement?: PanePlacement): void
  recentSessions(): RecentSessionSummary[]
  openRecent(source: WorkspaceWindow, id: string): Promise<void>
  findSession(source: WorkspaceWindow, target: SessionTarget, anchor: Point): Promise<void>
  serverAccounts(): ServerAccountsSnapshot
  loginServer(origin: string): Promise<void>
  cancelServerLogin(origin: string): void
  logoutServer(origin: string): Promise<void>
  refreshServers(): Promise<void>
  removeRecent(id: string): Promise<void>
  clearRecent(): Promise<void>
  quitting(): boolean
  focused(window: WorkspaceWindow): void
  closed(window: WorkspaceWindow): void
  changed(): void
  move(source: WorkspaceWindow, item: WorkspaceItem, destination: number | null, placement?: PanePlacement): void
  destinations(source: WorkspaceWindow): { id: number; label: string }[]
  dragStart(source: WorkspaceWindow, item: WorkspaceItem): void
  dragEnd(source: WorkspaceWindow, cancel: boolean): void
  dragCancel(window: WorkspaceWindow): boolean
  dragState(window: WorkspaceWindow): WorkspaceDragState | null
}

/** One window owns layout and chrome; the application owns terminal lifetimes. */
export class WorkspaceWindow {
  private window: BrowserWindow | null = null
  private layout = new WindowLayout()
  private geometry: TabGeometry | null = null
  private readonly closing: WorkspaceClose<TerminalPane>
  private reportingError = false
  private presenting = false
  constructor(
    private directory: string,
    private preferences: Preferences,
    private terminals: TerminalPanes,
    private host: WorkspaceHost,
  ) {
    this.closing = new WorkspaceClose({
      resolve: scope => {
        const ids = scope.kind === 'window' ? this.paneIds : this.layout.selection(scope)
        return ids.flatMap(id => this.pane(id) ?? [])
      },
      confirm: (scope, panes) => this.confirmClose(scope, panes),
      dispose: pane => this.terminals.dispose(pane.id),
      settled: () => {
        this.closeEmpty()
        this.restoreFocus()
      },
    })
  }
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
    if (!keepsWorkspaceDrag(command.name)) this.host.dragCancel(this)
    switch (command.name) {
      case 'state':
        return this.snapshot()
      case 'newLocal':
        return this.host.newLocal(this, command.args[0])
      case 'shellMenu':
        return this.shellMenu()
      case 'activateTab':
        return this.activateTab(command.args[0], command.args[1] !== false)
      case 'activatePane':
        return this.activatePane(command.args[0], command.args[1] !== false)
      case 'closeTab':
        return this.closeTab(command.args[0])
      case 'closePane':
        return this.closePane(command.args[0])
      case 'paneMenu':
        return this.paneMenu(command.args[0])
      case 'zoomPane':
        return this.zoomPane(command.args[0])
      case 'renameTab': {
        const [id, label] = command.args
        const tab = this.layout.tab(id)
        if (tab) {
          this.layout.renameTab(id, label)
          this.panel(null)
        }
        return
      }
      case 'panel': {
        const value = command.args[0]
        if (value === null || typeof value === 'string' || this.layout.tab(value.renameTab)) this.panel(value)
        return
      }
      case 'movePaneBeside':
        return this.movePaneBeside(...command.args)
      case 'splitPane':
        return this.splitPane(...command.args)
      case 'resizeSplit':
        this.layout.resizeSplit(...command.args)
        this.render()
        return
      case 'tabMenu':
        return this.tabMenu(command.args[0])
      case 'reloadPane':
        return this.reloadPane(command.args[0])
      case 'loginServer':
        return this.host.loginServer(command.args[0])
      case 'cancelServerLogin':
        return this.host.cancelServerLogin(command.args[0])
      case 'logoutServer':
        return this.host.logoutServer(command.args[0])
      case 'refreshServers':
        return this.host.refreshServers()
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
        if (command.args[0].tabs.every(tab => this.layout.tab(tab.id))) this.geometry = command.args[0]
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
  get paneIds() {
    return [...this.layout.paneIds]
  }
  hasPane(id: number) {
    return this.layout.paneIds.includes(id)
  }
  private pane(id: number) {
    return this.hasPane(id) ? this.terminals.panes.get(id) : undefined
  }
  get hasTabs() {
    return this.layout.tabs.length > 0
  }
  focused(id: number) {
    return Boolean(
      this.window?.isFocused() &&
      !this.host.dragState(this) &&
      this.layout.panel === null &&
      this.layout.activePaneId === id &&
      !this.terminals.panes.get(id)?.error,
    )
  }
  focus(id: number) {
    if (
      !this.host.dragState(this) &&
      !this.presenting &&
      this.layout.visiblePaneIds().includes(id) &&
      this.layout.activePaneId !== id
    )
      this.activatePane(id)
  }
  private snapshot(): WorkspaceSnapshot {
    const panes: PaneSummary[] = this.paneIds.flatMap(id => {
      const pane = this.terminals.panes.get(id)
      return pane
        ? [
            {
              ...pane.state,
              kind: pane.connection.kind,
              id,
              origin: pane.origin,
              label: pane.state.title,
              error: pane.error,
            },
          ]
        : []
    })
    return {
      version: app.getVersion(),
      platform: process.platform,
      activePaneId: this.layout.activePaneId,
      activeTabId: this.layout.activeTabId,
      tree: this.layout.activeTab?.root ?? null,
      zoomed: this.layout.activeTab?.zoomed ?? false,
      panel: this.layout.panel,
      servers: this.host.serverAccounts(),
      recentSessions: this.host.recentSessions(),
      preferences: this.preferences.value,
      shells: this.host.shells().map(({ id, name }) => ({ id, name })),
      defaultShell:
        this.host.shells().find(profile => profile.id === this.preferences.localShell)?.id ?? this.host.shells()[0].id,
      drag: this.host.dragState(this),
      panes,
      tabs: summarizeTabs(this.layout.tabs, panes),
    }
  }
  ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window
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
    attachWorkspaceShortcuts(window.webContents, {
      cycle: delta => {
        this.host.dragCancel(this)
        this.cycle(delta)
      },
      cancelDrag: () => this.host.dragCancel(this),
      pane: action => {
        this.host.dragCancel(this)
        this.paneAction(action)
      },
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
      this.terminals.hostState(this.paneIds)
    })
    window.on('blur', () => {
      this.host.dragCancel(this)
      this.terminals.hostState(this.paneIds)
    })
    window.on('close', event => {
      this.host.dragCancel(this)
      if (this.host.quitting() || !this.hasTabs) return
      event.preventDefault()
      void this.requestClose({ kind: 'window' }).catch(error => this.reportError(String(error)))
    })
    window.on('closed', () => {
      this.window = null
      for (const id of this.paneIds) this.terminals.dispose(id)
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
  addPane(pane: TerminalPane, placement: PanePlacement = { kind: 'tab', before: null }) {
    if (!this.attach(pane.id)) throw new Error('This terminal has closed.')
    this.layout.addPane(pane.id, placement)
  }
  attach(id: number) {
    const pane = this.terminals.panes.get(id)
    // Cancellation can run from a terminal's destroyed event. The other views
    // still return to their owner; restoreLayout prunes the dead leaf afterward.
    if (!pane || pane.view.webContents.isDestroyed()) return false
    this.ensureWindow().contentView.addChildView(pane.view)
    return true
  }
  detach(id: number) {
    const pane = this.terminals.panes.get(id)
    if (!pane) return
    if (!pane.view.webContents.isDestroyed()) pane.view.setVisible(false)
    if (this.window?.contentView.children.includes(pane.view)) this.window.contentView.removeChildView(pane.view)
  }
  selection(item: WorkspaceItem) {
    return this.layout.selection(item)
  }
  groupForPane(id: number) {
    return this.layout.tabForPane(id)?.id
  }
  extract(item: WorkspaceItem) {
    return this.layout.take(item)
  }
  insert(group: TabGroup, placement: PanePlacement) {
    this.layout.insert(group, placement)
  }
  captureLayout() {
    return this.layout.snapshot()
  }
  restoreLayout(state: WindowLayoutState) {
    this.layout.restore(state)
    for (const id of this.paneIds) {
      const pane = this.terminals.panes.get(id)
      if (!pane || pane.view.webContents.isDestroyed()) this.layout.removePane(id)
    }
    this.render()
  }
  removePane(id: number) {
    this.layout.removePane(id)
    this.render()
  }
  reorder(id: number, before: number | null) {
    this.layout.moveTab(id, before)
    this.activateTab(id)
  }
  placeTab(id: number, before: number | null) {
    this.layout.moveTab(id, before)
  }
  closeEmpty() {
    if (!this.hasTabs) this.window?.close()
  }
  activatePane(id: number, focusTerminal = true) {
    if (!this.hasPane(id)) return
    this.layout.activatePane(id)
    if (focusTerminal) this.show()
    else this.render()
  }
  activateTab(id: number, focusTerminal = true) {
    const group = this.layout.tab(id)
    if (group) this.activatePane(group.activePaneId, focusTerminal)
  }
  panel(panel: WorkspacePanel) {
    this.layout.panel = panel
    this.show()
  }
  private focusTerminal() {
    const pane = this.layout.activePaneId === null ? undefined : this.terminals.panes.get(this.layout.activePaneId)
    if (this.layout.panel !== null || !pane || pane.error) this.window?.webContents.focus()
    else {
      pane.view.webContents.focus()
      pane.view.webContents.send('terminal:command', 'focus')
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
    const visible = this.layout.visiblePaneIds()
    const geometry = this.paneGeometry(area.width, area.height)
    for (const id of this.layout.paneIds) {
      const pane = this.terminals.panes.get(id)!
      if (!pane || pane.view.webContents.isDestroyed()) continue
      const rectangle = geometry.panes.find(pane => pane.id === id)
      const shown =
        visible.includes(pane.id) &&
        !pane.error &&
        !!rectangle &&
        rectangle.content.width > 0 &&
        rectangle.content.height > 0
      if (shown) {
        const bounds = rectangle!.content
        const next = { ...bounds, y: bounds.y + tabBarHeight }
        const previous = pane.view.getBounds()
        if (
          next.x !== previous.x ||
          next.y !== previous.y ||
          next.width !== previous.width ||
          next.height !== previous.height
        )
          pane.view.setBounds(next)
      }
      pane.appearance.setDimmed(shown && id !== this.layout.activePaneId)
      if (pane.view.getVisible() !== shown) pane.view.setVisible(shown)
    }
    const active = this.layout.activePaneId === null ? undefined : this.terminals.panes.get(this.layout.activePaneId)
    window.setTitle(active ? `${this.layout.activeTab?.label || active.state.title} · Outpost` : 'Outpost')
    window.webContents.send('workspace:state', this.snapshot())
    this.terminals.hostState(this.paneIds)
  }
  cycle(delta: number) {
    this.layout.cycleTabs(delta)
    this.render()
    this.focusTerminal()
  }
  select(index: number) {
    const tab = index === 8 ? this.layout.tabs.at(-1) : this.layout.tabs[index]
    if (tab) this.activateTab(tab.id)
  }
  splitPane(id: number, direction: SplitDirection) {
    if (!this.hasPane(id)) return
    this.layout.activatePane(id)
    try {
      this.host.newLocal(this, undefined, {
        kind: 'pane',
        pane: id,
        edge: direction === 'columns' ? 'right' : 'bottom',
      })
    } catch (error) {
      void this.reportError((error as Error).message)
    }
  }
  paneAction(action: PaneAction) {
    const id = this.layout.focusedPaneId
    if (id === null) return
    switch (action) {
      case 'splitColumns':
        return this.splitPane(id, 'columns')
      case 'splitRows':
        return this.splitPane(id, 'rows')
      case 'zoom':
        return this.zoomPane(id)
      case 'close':
        void this.closePane(id)
        return
      case 'next':
        return this.otherPane()
    }
  }
  zoomPane(id: number) {
    const tab = this.layout.tabForPane(id)
    if (!tab || tab.root.kind === 'pane') return
    this.layout.activatePane(id)
    this.layout.toggleZoom(id)
    this.render()
    this.focusTerminal()
  }
  private movePaneBeside(id: number, active: number) {
    if (id !== active && this.hasPane(id) && this.hasPane(active))
      this.host.move(this, { kind: 'pane', id }, this.window!.id, { kind: 'pane', pane: active, edge: 'right' })
  }
  otherPane() {
    const group = this.layout.activeTab
    if (!group) return
    const ids = paneIds(group.root)
    this.activatePane(ids[(ids.indexOf(group.activePaneId) + 1) % ids.length])
  }
  private paneGeometry(width?: number, height?: number) {
    const size = this.window?.getContentSize() ?? [0, 0]
    const tab = this.layout.activeTab
    return paneLayout(
      width ?? size[0],
      height ?? Math.max(0, size[1] - tabBarHeight),
      tab?.root ?? null,
      tab?.zoomed ? tab.activePaneId : null,
    )
  }
  command(command: Exclude<TerminalCommand, 'focus'>) {
    const pane = this.layout.activePaneId === null ? undefined : this.terminals.panes.get(this.layout.activePaneId)
    if (this.layout.panel === null && pane && !pane.error) {
      if (command === 'find') pane.view.webContents.focus()
      pane.view.webContents.send('terminal:command', command)
    } else if (command === 'select-all') this.window?.webContents.selectAll()
  }
  edit(action: 'copy' | 'paste') {
    const pane = this.layout.activePaneId === null ? undefined : this.terminals.panes.get(this.layout.activePaneId)
    const contents =
      this.layout.panel === null && pane && !pane.error ? pane.view.webContents : this.window?.webContents
    if (!contents || contents.isDestroyed()) return
    contents.focus()
    if (action === 'copy') contents.copy()
    else contents.paste()
  }
  private requestClose(scope: CloseScope) {
    this.host.dragCancel(this)
    return this.closing.request(scope)
  }
  async closePane(id = this.layout.focusedPaneId) {
    if (id !== null) await this.requestClose({ kind: 'pane', id })
  }
  async closeTab(id = this.layout.panel === null ? this.layout.activeTabId : null) {
    if (id !== null) await this.requestClose({ kind: 'tab', id })
  }
  private async confirmClose(scope: CloseScope, panes: readonly TerminalPane[]) {
    const window = this.window
    if (!window || window.isDestroyed()) return false
    const title =
      scope.kind === 'pane'
        ? `“${panes[0].state.title}”`
        : scope.kind === 'tab'
          ? `this tab and its ${panes.length} panes`
          : `this window and its ${panes.length} panes`
    const detail = [
      panes.some(pane => pane.connection.kind === 'local') ? 'Local shells and their processes will end.' : '',
      panes.some(pane => pane.connection.kind === 'remote') ? 'Remote sessions keep running.' : '',
      panes.some(pane => pane.state.hasDraft) ? 'Unsent messages will be discarded.' : '',
    ]
      .filter(Boolean)
      .join(' ')
    const result = await dialog.showMessageBox(window, {
      type: 'question',
      message: `Close ${title}?`,
      detail,
      buttons: [scope.kind === 'pane' ? 'Close pane' : scope.kind === 'tab' ? 'Close tab' : 'Close window', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    return result.response === 0
  }
  private async confirmDraft(pane: TerminalPane) {
    if (!this.window) return false
    const result = await dialog.showMessageBox(this.window, {
      type: 'question',
      message: 'Discard the unsent message?',
      detail: `${pane.state.title} has a draft in its message box.${pane.connection.kind === 'remote' ? ' The remote session will keep running.' : ''}`,
      buttons: ['Discard draft', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    return result.response === 0
  }
  async reloadPane(id = this.layout.focusedPaneId) {
    if (id === null) return
    const pane = this.pane(id)
    if (!pane || (pane.state.hasDraft && !(await this.confirmDraft(pane)))) return
    if (pane.connection.kind === 'local' && pane.connection.terminal.running && this.window) {
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
    if (this.pane(id) !== pane) return
    this.terminals.reloadPane(id)
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
    const anchor = screen.getCursorScreenPoint()
    Menu.buildFromTemplate([
      ...this.host.shells().map(profile => ({
        label: profile.name,
        click: () => {
          try {
            this.host.newLocal(this, profile.id)
          } catch (error) {
            void this.reportError((error as Error).message)
          }
        },
      })),
      { type: 'separator' },
      { label: 'Outpost terminal…', click: () => this.findSession({ kind: 'tab' }, anchor) },
    ]).popup({ window: this.window })
  }

  private findSession(target: SessionTarget, anchor: Point) {
    void this.host.findSession(this, target, anchor).catch(error => this.reportError(String(error)))
  }

  private tabMenu(id: number) {
    const group = this.layout.tab(id)
    if (!group || !this.window) return
    const item: WorkspaceItem = { kind: 'tab', id }
    const anchor = screen.getCursorScreenPoint()
    Menu.buildFromTemplate([
      { label: 'Rename tab…', click: () => this.panel({ renameTab: id }) },
      { label: 'Move tab to new window', click: () => this.host.move(this, item, null) },
      {
        label: 'Move tab to window',
        enabled: this.host.destinations(this).length > 0,
        submenu: this.host
          .destinations(this)
          .map(destination => ({ label: destination.label, click: () => this.host.move(this, item, destination.id) })),
      },
      {
        label: 'Split with new local terminal',
        click: () => {
          this.splitPane(group.activePaneId, 'columns')
        },
      },
      {
        label: 'Split with Outpost terminal…',
        click: () => this.findSession({ kind: 'split', tabId: id, paneId: group.activePaneId }, anchor),
      },
      {
        label: 'Move beside current tab',
        enabled: this.layout.activePaneId !== null && this.layout.activeTab?.id !== id,
        click: () => {
          const active = this.layout.activePaneId
          if (active !== null && this.layout.activeTab?.id !== id)
            this.host.move(this, item, this.window!.id, { kind: 'pane', pane: active, edge: 'right' })
        },
      },
      {
        label: 'Reload focused terminal',
        click: () => {
          void this.reloadPane(group.activePaneId)
        },
      },
      { type: 'separator' },
      {
        label: 'Move tab left',
        enabled: this.layout.tabs.findIndex(tab => tab.id === id) > 0,
        click: () => {
          const index = this.layout.tabs.findIndex(tab => tab.id === id)
          if (index > 0) this.reorder(id, this.layout.tabs[index - 1].id)
        },
      },
      {
        label: 'Move tab right',
        enabled: this.layout.tabs.findIndex(tab => tab.id === id) < this.layout.tabs.length - 1,
        click: () => {
          const index = this.layout.tabs.findIndex(tab => tab.id === id)
          if (index >= 0) this.reorder(id, this.layout.tabs[index + 2]?.id ?? null)
        },
      },
      { type: 'separator' },
      {
        label: 'Close tab',
        click: () => {
          void this.closeTab(id)
        },
      },
    ]).popup({ window: this.window })
  }
  private paneMenu(id: number) {
    if (!this.hasPane(id) || !this.window) return
    const item: WorkspaceItem = { kind: 'pane', id }
    Menu.buildFromTemplate([
      {
        label: 'Split side by side with local terminal',
        click: () => {
          this.splitPane(id, 'columns')
        },
      },
      {
        label: 'Split top and bottom with local terminal',
        click: () => {
          this.splitPane(id, 'rows')
        },
      },
      {
        label: this.layout.tabForPane(id)?.zoomed ? 'Restore split panes' : 'Zoom pane',
        click: () => {
          this.zoomPane(id)
        },
      },
      { type: 'separator' },
      { label: 'Move pane to its own tab', click: () => this.host.move(this, item, this.window!.id) },
      { label: 'Move pane to new window', click: () => this.host.move(this, item, null) },
      {
        label: 'Move pane to window',
        enabled: this.host.destinations(this).length > 0,
        submenu: this.host
          .destinations(this)
          .map(destination => ({ label: destination.label, click: () => this.host.move(this, item, destination.id) })),
      },
      { type: 'separator' },
      {
        label: 'Reload terminal',
        click: () => {
          void this.reloadPane(id)
        },
      },
      {
        label: 'Close pane',
        click: () => {
          void this.closePane(id)
        },
      },
    ]).popup({ window: this.window })
  }
  paneDropAt(point: Point, excluded: number[]) {
    if (!this.window || this.layout.panel !== null) return null
    const origin = this.window.getContentBounds(),
      x = point.x - origin.x,
      y = point.y - origin.y - tabBarHeight
    const pane = this.paneGeometry().panes.find(
      ({ bounds: b }) => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height,
    )
    if (!pane || excluded.includes(pane.id)) return null
    const b = pane.bounds
    const distances = {
      left: (x - b.x) / b.width,
      right: (b.x + b.width - x) / b.width,
      top: (y - b.y) / b.height,
      bottom: (b.y + b.height - y) / b.height,
    }
    const edge = (Object.keys(distances) as (keyof typeof distances)[]).sort((a, b) => distances[a] - distances[b])[0]
    const horizontal = edge === 'left' || edge === 'right'
    const bounds = { x: origin.x + b.x, y: origin.y + tabBarHeight + b.y, width: b.width, height: b.height }
    if (horizontal) {
      bounds.width = Math.floor(bounds.width / 2)
      if (edge === 'right') bounds.x += b.width - bounds.width
    } else {
      bounds.height = Math.floor(bounds.height / 2)
      if (edge === 'bottom') bounds.y += b.height - bounds.height
    }
    return { placement: { kind: 'pane' as const, pane: pane.id, edge }, bounds }
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
    const tabs = this.geometry.tabs.filter(tab => this.layout.tab(tab.id))
    const moving = tabs.find(tab => tab.id === dragged)
    if (moving && x >= moving.left && x < moving.right) return dragged
    return tabs.find(tab => x < (tab.left + tab.right) / 2)?.id ?? null
  }
  scrollAt(point: Point) {
    if (!this.window || !this.geometry) return 0
    const x = point.x - this.window.getContentBounds().x
    if (x < this.geometry.left || x > this.geometry.viewportRight) return 0
    return x < this.geometry.left + 24 ? -1 : x > this.geometry.viewportRight - 24 ? 1 : 0
  }
}
