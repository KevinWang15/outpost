import { app, BrowserWindow, dialog, ipcMain, screen, type Point } from 'electron'
import type { DesktopLaunch } from '../../shared/desktop'
import { Preferences } from './preferences'
import { TrustedServers } from './store'
import { TerminalTabs } from './terminals'
import { TabDrag } from './tab-drag'
import { transferTab } from './tab-transfer'
import { WorkspaceWindow } from './workspace-window'

/** App-wide terminal identity and ownership; moving a tab never recreates its view. */
export class DesktopWorkspace {
  private windows = new Map<number, WorkspaceWindow>()
  private owners = new Map<number, WorkspaceWindow>()
  private recent: number[] = []
  private terminals: TerminalTabs
  private drag: TabDrag
  private confirmingQuit = false
  quitting = false

  constructor(
    private directory: string,
    private trusted: TrustedServers,
    private preferences: Preferences,
    private trust: (origin: string) => Promise<boolean>,
  ) {
    this.terminals = new TerminalTabs(directory, {
      window: id => this.owners.get(id)?.browserWindow ?? null,
      focused: id => this.owners.get(id)?.focused(id) ?? false,
      activate: id => {
        this.drag.cancel()
        this.owners.get(id)?.activate(id)
      },
      focus: id => this.owners.get(id)?.focus(id),
      close: async id => {
        this.drag.cancel()
        await this.owners.get(id)?.close(id)
      },
      removing: id => {
        const owner = this.owners.get(id)
        if (owner) this.drag.cancelWindow(owner)
      },
      removed: id => {
        const owner = this.owners.get(id)
        this.owners.delete(id)
        owner?.remove(id)
      },
      changed: id => this.owners.get(id)?.render(),
      state: id => ({ ...preferences.value, focused: this.owners.get(id)?.focused(id) ?? false }),
    })
    this.drag = new TabDrag({
      windows: () => this.recent.flatMap(id => this.windows.get(id) ?? []),
      changed: () => this.render(),
      preview: (id, target, before) => {
        const source = this.owners.get(id),
          tab = this.terminals.tabs.get(id)
        if (!source || !tab) throw new Error('This terminal is no longer available.')
        return transferTab(tab, source, target, before, window => this.owners.set(id, window))
      },
      drop: (source, id, destination, before, point) => {
        this.move(id, destination, before, point)
        source.closeEmpty()
      },
      failed: error =>
        dialog.showErrorBox(
          'Could not move tab',
          error instanceof Error ? error.message : 'Try dragging the tab again.',
        ),
    })
    ipcMain.handle('workspace:action', (event, name: unknown, ...values: unknown[]) => {
      const window = [...this.windows.values()].find(item => item.browserWindow?.webContents === event.sender)
      if (!window) throw new Error('This action is only available in an Outpost window.')
      return window.invoke(event, name, values)
    })
  }

  get hasTabs() {
    return this.terminals.tabs.size > 0
  }
  get current() {
    const focused = BrowserWindow.getFocusedWindow()
    return (
      (focused && this.windows.get(focused.id)) ||
      this.recent.map(id => this.windows.get(id)).find(window => window !== undefined) ||
      this.create()
    )
  }
  forAction() {
    // Menu/OS actions finish any provisional drag before resolving ownership.
    this.drag.cancel()
    return this.current
  }
  show() {
    this.forAction().show()
  }
  newWindow() {
    this.drag.cancel()
    try {
      this.create().show()
    } catch (error) {
      dialog.showErrorBox('Outpost', (error as Error).message)
    }
  }

  private create() {
    if (this.windows.size >= 16) throw new Error('Close a window before opening another (16 windows maximum).')
    const workspace = new WorkspaceWindow(this.directory, this.trusted, this.preferences, this.trust, this.terminals, {
      quitting: () => this.quitting,
      focused: window => {
        const id = window.browserWindow!.id
        this.recent = [id, ...this.recent.filter(value => value !== id)]
      },
      closed: window => {
        this.drag.cancelWindow(window)
        for (const [id, item] of this.windows)
          if (item === window) {
            this.windows.delete(id)
            this.recent = this.recent.filter(value => value !== id)
          }
      },
      changed: () => this.render(),
      destinations: source =>
        [...this.windows]
          .filter(([, window]) => window !== source)
          .map(([id, window]) => ({
            id,
            label: window.browserWindow?.getTitle() || 'Outpost',
          })),
      move: (id, destination) => {
        const target = destination === null ? null : this.windows.get(destination)
        if (target === undefined) return
        this.drag.cancelTab(id)
        try {
          this.move(id, target, null)
        } catch (error) {
          dialog.showErrorBox('Outpost', (error as Error).message)
        }
      },
      dragStart: (source, id) => {
        if (this.quitting || !source.has(id) || !source.browserWindow?.isFocused()) return
        const tab = this.terminals.tabs.get(id)!
        this.drag.start(source, id, tab.label || tab.state.title)
      },
      dragEnd: (source, cancel) => this.drag.end(source, cancel),
      dragCancel: window => this.drag.cancelWindow(window),
      dragState: window => this.drag.state(window),
    })
    const window = workspace.ensureWindow()
    this.windows.set(window.id, workspace)
    this.recent.push(window.id)
    return workspace
  }

  open(launch: DesktopLaunch) {
    this.drag.cancel()
    const { tab, created } = this.terminals.open(launch)
    let owner = this.owners.get(tab.id)
    if (created) {
      owner = this.current
      this.owners.set(tab.id, owner)
      owner.add(tab)
    }
    owner?.activate(tab.id)
  }

  private position(window: BrowserWindow, source: BrowserWindow, point?: Point) {
    const previous = source.getBounds()
    const anchor = point ?? { x: previous.x + 64, y: previous.y + 48 }
    const area = screen.getDisplayNearestPoint(anchor).workArea
    const width = Math.min(previous.width, area.width),
      height = Math.min(previous.height, area.height)
    if (window.isMaximized()) window.unmaximize()
    window.setBounds({
      width,
      height,
      x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, anchor.x - (point ? 100 : 0)))),
      y: Math.round(Math.max(area.y, Math.min(area.y + area.height - height, anchor.y - (point ? 20 : 0)))),
    })
  }

  private move(id: number, destination: WorkspaceWindow | null, before: number | null, point?: Point) {
    const source = this.owners.get(id),
      tab = this.terminals.tabs.get(id)
    if (!source || !tab || !source.browserWindow || this.quitting) return
    if (destination === source) return source.reorder(id, before)
    if (destination && (!destination.browserWindow || (before !== null && !destination.has(before)))) return
    // A lone tab already has its own window. Moving that window preserves its
    // native identity too; no temporary empty window or app exit is needed.
    if (!destination && source.ids.length === 1 && !source.browserWindow.isFullScreen()) {
      this.position(source.browserWindow, source.browserWindow, point)
      source.show()
      return
    }
    const target = destination ?? this.create()
    if (!destination) this.position(target.browserWindow!, source.browserWindow, point)
    try {
      transferTab(tab, source, target, before, window => this.owners.set(id, window))
    } catch (error) {
      if (!destination) target.closeEmpty()
      throw error
    }
    target.activate(id)
    source.closeEmpty()
  }

  private render() {
    for (const window of this.windows.values()) window.render()
  }

  async quit() {
    if (this.confirmingQuit) return
    this.confirmingQuit = true
    this.drag.cancel()
    try {
      const tabs = [...this.terminals.tabs.values()]
      const draft = tabs.some(tab => tab.state.hasDraft)
      if (tabs.length > 1 || draft) {
        const result = await dialog.showMessageBox(this.current.ensureWindow(), {
          type: 'question',
          message: `Close ${tabs.length} terminal tabs across ${this.windows.size} windows?`,
          detail: `Remote sessions keep running.${draft ? ' Unsent messages will be discarded.' : ''}`,
          buttons: ['Quit Outpost', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        })
        if (result.response !== 0) return
      }
      this.quitting = true
      app.quit()
    } finally {
      this.confirmingQuit = false
    }
  }
}
