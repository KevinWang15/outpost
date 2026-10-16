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
import type { ShellProfile } from './shell-profiles'
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
  private actions = new Map<string, (...values: unknown[]) => unknown>()
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
  ) {
    const handle = <Args extends unknown[]>(name: string, action: (...values: Args) => unknown) => {
      this.actions.set(name, (...values) => Reflect.apply(action, undefined, values))
    }
    handle('state', () => this.snapshot())
    handle('new-local', (profile?: string) => {
      if (profile !== undefined && typeof profile !== 'string') throw new Error('Choose a local shell.')
      this.host.newLocal(this, profile)
    })
    handle('shell-menu', () => {
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
    })
    handle('activate', (id: number, focusTerminal?: boolean) => this.activate(id, focusTerminal !== false))
    handle('close', (id: number) => this.close(id))
    handle('reorder', (id: number, before: number | null) => {
      this.layout.move(id, before)
      this.render()
    })
    handle('rename', (id: number, label: string) => {
      const tab = this.tab(id)
      if (
        !tab ||
        typeof label !== 'string' ||
        label.length > 120 ||
        [...label].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      )
        return
      tab.label = label.trim() || null
      this.panel(null)
    })
    handle('panel', (value: WorkspacePanel) => {
      if (
        value === null ||
        (typeof value === 'string' && ['sessions', 'switcher', 'settings'].includes(value)) ||
        (value && typeof value === 'object' && this.has(value.rename))
      )
        this.panel(value)
    })
    handle('pair', (id: number) => {
      this.layout.pair(id)
      this.render()
      this.focusTerminal()
    })
    handle('split', (direction: SplitDirection | null) => this.split(direction))
    handle('ratio', (ratio: number) => {
      if (this.layout.split && typeof ratio === 'number' && Number.isFinite(ratio)) {
        this.layout.split.ratio = Math.max(0.2, Math.min(0.8, ratio))
        this.render()
      }
    })
    handle('context-menu', (id: number) => this.contextMenu(id))
    handle('reload', (id: number) => this.reload(id))
    handle('open-server', (value: string) => this.openServer(value))
    handle('forget-server', (value: string) => this.forgetServer(value))
    handle('preferences', (value: TerminalPreferences, shell: string) => {
      if (!this.host.shells().some(profile => profile.id === shell)) throw new Error('Choose an available local shell.')
      return this.setPreferences(value, shell)
    })
    handle('updates', checkUpdates)
    handle('report-error', (message: string) => this.reportError(message))
    handle('tab-geometry', (value: TabGeometry) => this.setGeometry(value))
    handle('drag-start', (id: number) => this.host.dragStart(this, id))
    handle('drag-end', (cancel: boolean) => this.host.dragEnd(this, cancel !== false))
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
    const action = typeof name === 'string' ? this.actions.get(name) : undefined
    if (!action) throw new Error('Unknown workspace action.')
    if (!['state', 'tab-geometry', 'drag-start', 'drag-end'].includes(name as string)) this.host.dragCancel(this)
    return action(...values)
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
      if (this.allowWindowClose || this.host.quitting() || !this.needsWindowConfirmation()) return
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
      if (tab.state.hasDraft && !(await this.confirmDraft(tab))) return
      if (!this.has(id)) return
      this.terminals.dispose(id)
      this.focusTerminal()
    } finally {
      this.closing.delete(id)
    }
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
  private needsWindowConfirmation() {
    return (
      this.hasTabs &&
      (this.layout.ids.length > 1 ||
        this.ids.some(id => {
          const tab = this.tab(id)
          return tab?.state.hasDraft || (tab?.connection.kind === 'local' && tab.connection.terminal.running)
        }))
    )
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

  private setGeometry(value: TabGeometry) {
    const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100_000
    if (
      !value ||
      ![value.left, value.right, value.viewportRight].every(finite) ||
      value.left < 0 ||
      value.right <= value.left ||
      value.viewportRight < value.left ||
      value.viewportRight > value.right ||
      !Array.isArray(value.tabs) ||
      value.tabs.length > 32 ||
      value.tabs.some(
        tab => !tab || !this.has(tab.id) || !finite(tab.left) || !finite(tab.right) || tab.right < tab.left,
      )
    )
      return
    this.geometry = value
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
