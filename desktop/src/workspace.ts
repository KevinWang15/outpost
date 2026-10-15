import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { desktopOrigin, type DesktopLaunch, type TerminalPreferences } from '../../shared/desktop'
import { paneLayout, splitRatio, TabLayout } from './layout'
import { defaultPreferences, Preferences, validPreferences } from './preferences'
import { TrustedServers } from './store'
import { TerminalTabs, type TerminalTab } from './terminals'
import { checkUpdates } from './updates'
import {
  statusBarHeight,
  tabBarHeight,
  type SplitDirection,
  type WorkspacePanel,
  type WorkspaceSnapshot,
} from './workspace-api'

/** The main process owns tab identity, layout and focus. Local chrome sees metadata only. */
export class DesktopWorkspace {
  private window: BrowserWindow | null = null
  private layout = new TabLayout()
  private terminals: TerminalTabs
  private closing = new Set<number>()
  private confirmingWindow = false
  private allowWindowClose = false
  quitting = false
  constructor(
    private directory: string,
    private trusted: TrustedServers,
    private preferences: Preferences,
    private trust: (origin: string) => Promise<boolean>,
  ) {
    this.terminals = new TerminalTabs(directory, {
      window: () => this.window,
      focused: id => this.focused(id),
      activate: id => this.activate(id),
      close: id => this.close(id),
      removed: id => {
        this.layout.remove(id)
        this.render()
      },
      changed: () => this.render(),
      state: id => ({ ...preferences.value, focused: this.focused(id) }),
    })
    const handle = <Args extends unknown[]>(name: string, action: (...values: Args) => unknown) => {
      ipcMain.handle('workspace:' + name, (event, ...values: unknown[]) => {
        this.sender(event)
        return Reflect.apply(action, undefined, values)
      })
    }
    handle('state', () => this.snapshot())
    handle('activate', (id: number) => this.activate(id))
    handle('close', (id: number) => this.close(id))
    handle('reorder', (id: number, before: number | null) => {
      this.layout.move(id, before)
      this.render()
    })
    handle('rename', (id: number, label: string) => {
      const tab = this.terminals.tabs.get(id)
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
        (value && typeof value === 'object' && this.terminals.tabs.has(value.rename))
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
    handle('preferences', (value: TerminalPreferences) => this.setPreferences(value))
    handle('updates', checkUpdates)
  }
  private sender(event: IpcMainInvokeEvent) {
    const url = pathToFileURL(join(this.directory, 'workspace.html')).href
    if (
      !this.window ||
      event.sender !== this.window.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame.url !== url
    )
      throw new Error('This action is only available in the Outpost workspace.')
  }
  get hasTabs() {
    return this.terminals.tabs.size > 0
  }
  private focused(id: number) {
    return Boolean(
      this.window?.isFocused() &&
      this.layout.panel === null &&
      this.layout.active === id &&
      !this.terminals.tabs.get(id)?.error,
    )
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
      tabs: this.layout.ids.flatMap(id => {
        const tab = this.terminals.tabs.get(id)
        return tab
          ? [{ ...tab.state, id, origin: tab.origin, label: tab.label || tab.state.title, error: tab.error }]
          : []
      }),
    }
  }
  private ensureWindow() {
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
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('did-finish-load', () => this.render())
    window.webContents.on('render-process-gone', () => {
      // Terminal views survive a local chrome crash; reload only the chrome.
      if (!window.isDestroyed()) void window.loadFile(join(this.directory, 'workspace.html')).catch(() => {})
    })
    window.on('resize', () => this.render())
    window.on('focus', () => this.terminals.hostState())
    window.on('blur', () => this.terminals.hostState())
    window.on('close', event => {
      if (this.allowWindowClose || this.quitting || !this.needsWindowConfirmation()) return
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
      for (const id of [...this.terminals.tabs.keys()]) this.terminals.dispose(id)
    })
    window.once('ready-to-show', () => {
      window.show()
      this.focusTerminal()
    })
    void window.loadFile(join(this.directory, 'workspace.html')).catch(() => {})
    return window
  }
  show() {
    const window = this.ensureWindow()
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    this.render()
    this.focusTerminal()
  }
  open(launch: DesktopLaunch) {
    const window = this.ensureWindow()
    const { tab, created } = this.terminals.open(launch)
    if (created) {
      window.contentView.addChildView(tab.view)
      this.layout.add(tab.id)
    }
    this.activate(tab.id)
  }
  activate(id: number) {
    if (!this.terminals.tabs.has(id)) return
    this.layout.activate(id)
    const tab = this.terminals.tabs.get(id)!
    tab.state.attention = false
    this.terminals.dismiss(tab)
    this.show()
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
  private render() {
    const window = this.window
    if (!window || window.isDestroyed()) return
    const [width, height] = window.getContentSize()
    const area = { x: 0, y: tabBarHeight, width, height: Math.max(0, height - tabBarHeight - statusBarHeight) }
    const visible = this.layout.visible()
    if (this.layout.split) this.layout.split.ratio = splitRatio(area.width, area.height, this.layout.split)
    const geometry = paneLayout(area.width, area.height, this.layout.split)
    for (const tab of this.terminals.tabs.values()) {
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
    this.terminals.hostState()
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
  command(command: 'select-all' | 'reconnect') {
    const tab = this.layout.active === null ? undefined : this.terminals.tabs.get(this.layout.active)
    if (this.layout.panel === null && tab && !tab.error) tab.view.webContents.send('terminal:command', command)
    else if (command === 'select-all') this.window?.webContents.selectAll()
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
    const tab = this.terminals.tabs.get(id)
    if (!tab) return
    this.closing.add(id)
    try {
      if (tab.state.hasDraft && !(await this.confirmDraft(tab))) return
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
      detail: `${tab.label || tab.state.title} has a draft in its message box. The remote session will keep running.`,
      buttons: ['Discard draft', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    return result.response === 0
  }
  async reload(id = this.layout.active) {
    if (id === null) return
    const tab = this.terminals.tabs.get(id)
    if (!tab || (tab.state.hasDraft && !(await this.confirmDraft(tab)))) return
    tab.error = null
    tab.state = { ...tab.state, hasDraft: false, connection: 'connecting' }
    tab.view.webContents.reload()
    this.render()
  }
  private needsWindowConfirmation() {
    return (
      this.hasTabs &&
      (this.terminals.tabs.size > 1 || [...this.terminals.tabs.values()].some(tab => tab.state.hasDraft))
    )
  }
  private async confirmWindow() {
    if (!this.window) return true
    const draft = [...this.terminals.tabs.values()].some(tab => tab.state.hasDraft)
    const result = await dialog.showMessageBox(this.window, {
      type: 'question',
      message: `Close ${this.terminals.tabs.size} terminal tabs?`,
      detail: `Remote sessions keep running. Connect from Outpost to open them again.${draft ? ' Unsent messages in the message boxes will be discarded.' : ''}`,
      buttons: ['Close tabs', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
    return result.response === 0
  }
  async quit() {
    if (this.confirmingWindow) return
    this.confirmingWindow = true
    try {
      if (this.needsWindowConfirmation() && !(await this.confirmWindow())) return
      this.quitting = true
      app.quit()
    } finally {
      this.confirmingWindow = false
    }
  }
  private async openServer(value: unknown) {
    if (typeof value !== 'string') throw new Error('Enter an Outpost server URL.')
    const origin = desktopOrigin(value)
    if (!(await this.trust(origin))) return false
    this.render()
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
        message: `Forget this server and close ${tabs.length} tabs?`,
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
    this.render()
  }
  async setPreferences(value: TerminalPreferences) {
    if (!validPreferences(value)) throw new Error('Use a font size between 10 and 28.')
    await this.preferences.set(value)
    this.render()
  }
  fontSize(delta: number | null) {
    const size =
      delta === null ? defaultPreferences.fontSize : Math.max(10, Math.min(28, this.preferences.value.fontSize + delta))
    void this.setPreferences({ ...this.preferences.value, fontSize: size }).catch(() => {})
  }
  private contextMenu(id: number) {
    const tab = this.terminals.tabs.get(id)
    if (!tab || !this.window) return
    Menu.buildFromTemplate([
      { label: 'Rename tab…', click: () => this.panel({ rename: id }) },
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
}
