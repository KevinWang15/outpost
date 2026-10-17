import { app, BrowserWindow, dialog, ipcMain, screen, type Point } from 'electron'
import type { DesktopLaunch } from '../../shared/desktop'
import { Preferences } from './preferences'
import { TrustedServers } from './store'
import { TerminalPanes, type TerminalPane } from './terminals'
import { RecentSessions } from './recent-sessions'
import { WorkspaceDrag } from './workspace-drag'
import { transferPanes } from './pane-transfer'
import type { WorkspaceItem, PanePlacement, SplitDirection } from './workspace-model'
import { WorkspaceWindow } from './workspace-window'
import { shellProfiles } from './shell-profiles'

/** App-wide pane identity and window ownership; transfers preserve terminal views. */
export class DesktopWorkspace {
  readonly shells = shellProfiles()
  private windows = new Map<number, WorkspaceWindow>()
  private owners = new Map<number, WorkspaceWindow>()
  private recent: number[] = []
  private terminals: TerminalPanes
  private drag: WorkspaceDrag
  private confirmingQuit = false
  quitting = false

  constructor(
    private directory: string,
    private trusted: TrustedServers,
    private preferences: Preferences,
    private recentSessions: RecentSessions,
    private trust: (origin: string) => Promise<boolean>,
  ) {
    this.terminals = new TerminalPanes(directory, {
      window: id => this.owners.get(id)?.browserWindow ?? null,
      focused: id => this.owners.get(id)?.focused(id) ?? false,
      activate: id => {
        this.drag.cancel()
        this.owners.get(id)?.activatePane(id)
      },
      focus: id => this.owners.get(id)?.focus(id),
      cancelDrag: () => this.drag.cancel(),
      paneAction: (id, action) => {
        this.drag.cancel()
        this.owners.get(id)?.paneAction(action)
      },
      cycle: (id, delta) => {
        this.drag.cancel()
        this.owners.get(id)?.cycle(delta)
      },
      close: async id => {
        this.drag.cancel()
        await this.owners.get(id)?.closePane(id)
      },
      removing: id => {
        const owner = this.owners.get(id)
        if (owner) this.drag.cancelWindow(owner)
      },
      removed: id => {
        const owner = this.owners.get(id)
        this.owners.delete(id)
        owner?.removePane(id)
        owner?.closeEmpty()
      },
      changed: id => this.owners.get(id)?.render(),
      state: id => ({ ...preferences.value, focused: this.owners.get(id)?.focused(id) ?? false }),
      remember: async entry => {
        if (!this.trusted.has(entry.server)) return
        await this.recentSessions.remember(entry)
        this.render()
      },
    })
    this.drag = new WorkspaceDrag({
      windows: () => this.recent.flatMap(id => this.windows.get(id) ?? []),
      changed: () => this.render(),
      preview: (source, item, target, before) =>
        transferPanes(item, source, target, { kind: 'tab', before }, (id, window) => this.owners.set(id, window)),
      drop: (source, item, destination, placement, point) => this.move(source, item, destination, placement, point),
      committed: (source, target, active) => {
        target.activatePane(active)
        source.closeEmpty()
      },
      failed: error =>
        dialog.showErrorBox(
          'Could not move terminal',
          error instanceof Error ? error.message : 'Try dragging the pane or tab again.',
        ),
    })
    ipcMain.handle('workspace:action', (event, name: unknown, ...values: unknown[]) => {
      const window = [...this.windows.values()].find(item => item.browserWindow?.webContents === event.sender)
      if (!window) throw new Error('This action is only available in an Outpost window.')
      return window.invoke(event, name, values)
    })
  }

  get current() {
    const focused = BrowserWindow.getFocusedWindow()
    return (
      (focused && this.windows.get(focused.id)) ||
      this.recent.map(id => this.windows.get(id)).find(window => window !== undefined) ||
      null
    )
  }
  resume() {
    this.terminals.resume()
  }
  forAction() {
    // Menu/OS actions finish any provisional drag before resolving ownership.
    this.drag.cancel()
    return this.current
  }
  show() {
    const window = this.forAction() ?? this.create()
    if (!window.hasTabs) this.newLocal(undefined, window)
    else window.show()
  }
  present() {
    const window = this.forAction() ?? this.create()
    window.show()
  }
  newWindow() {
    this.drag.cancel()
    let window: WorkspaceWindow | undefined
    try {
      window = this.create()
      this.newLocal(undefined, window)
    } catch (error) {
      window?.closeEmpty()
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
      shells: () => this.shells,
      newLocal: (source, profile, split) => this.newLocal(profile, source, split),
      recentSessions: () => this.recentSessions.list(),
      openRecent: (source, id) => this.openRecent(source, id),
      removeRecent: async id => {
        this.terminals.forgetRecent(id)
        await this.recentSessions.remove(id)
        this.render()
      },
      clearRecent: async () => {
        this.terminals.forgetRecent()
        await this.recentSessions.clear()
        this.render()
      },
      forgetRecents: () => this.recentSessions.retainServers(origin => this.trusted.has(origin)),
      destinations: source =>
        [...this.windows]
          .filter(([, window]) => window !== source)
          .map(([id, window]) => ({
            id,
            label: window.browserWindow?.getTitle() || 'Outpost',
          })),
      move: (source, item, destination, placement = { kind: 'tab', before: null }) => {
        const target = destination === null ? null : this.windows.get(destination)
        if (target === undefined) return
        this.drag.cancel()
        try {
          this.move(source, item, target, placement)
        } catch (error) {
          dialog.showErrorBox('Outpost', (error as Error).message)
        }
      },
      dragStart: (source, item) => {
        const ids = source.selection(item)
        if (this.quitting || !ids.length || !source.browserWindow?.isFocused()) return
        const pane = this.terminals.panes.get(ids[0])!
        this.drag.start(source, item, pane.state.title)
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
    return this.activateOpened(this.terminals.open(launch))
  }

  private openRecent(source: WorkspaceWindow, id: string) {
    const entry = this.recentSessions.get(id)
    if (!entry || !this.trusted.has(entry.server)) throw new Error('This recent session is no longer available.')
    this.drag.cancel()
    return this.activateOpened(this.terminals.openRecent(entry), source)
  }

  private async activateOpened(
    { pane, created }: { pane: TerminalPane; created: boolean },
    destination?: WorkspaceWindow,
  ) {
    let owner = this.owners.get(pane.id)
    if (created) {
      owner = this.attachNewPane(pane, destination)
    }
    owner?.activatePane(pane.id)
    if (!created && pane.state.connection === 'connected') await this.terminals.remember(pane)
  }

  newLocal(profileId?: string, destination?: WorkspaceWindow, split?: SplitDirection) {
    this.drag.cancel()
    const profile =
      this.shells.find(item => item.id === (profileId ?? this.preferences.localShell)) ??
      (profileId === undefined ? this.shells[0] : undefined)
    if (!profile) throw new Error('Choose an available local shell.')
    const pane = this.terminals.openLocal(profile)
    const owner = this.attachNewPane(pane, destination, split)
    owner.activatePane(pane.id)
  }

  private attachNewPane(pane: TerminalPane, destination?: WorkspaceWindow, split?: SplitDirection) {
    let owner = destination ?? this.current
    try {
      owner ??= this.create()
      this.owners.set(pane.id, owner)
      owner.addPane(pane, split)
      return owner
    } catch (error) {
      this.terminals.dispose(pane.id)
      owner?.closeEmpty()
      throw error
    }
  }

  dispose() {
    for (const id of [...this.terminals.panes.keys()]) this.terminals.dispose(id)
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

  private move(
    source: WorkspaceWindow,
    item: WorkspaceItem,
    destination: WorkspaceWindow | null,
    placement: PanePlacement,
    point?: Point,
  ) {
    const ids = source.selection(item)
    if (!ids.length || !source.browserWindow || this.quitting) return
    // Moving the entire contents of a lone window preserves its native identity.
    if (!destination && source.paneIds.length === ids.length && !source.browserWindow.isFullScreen()) {
      this.position(source.browserWindow, source.browserWindow, point)
      source.show()
      return
    }
    const target = destination ?? this.create()
    if (!destination) this.position(target.browserWindow!, source.browserWindow, point)
    try {
      const result = transferPanes(item, source, target, placement, (id, window) => this.owners.set(id, window))
      target.activatePane(result.activePaneId)
      source.closeEmpty()
    } catch (error) {
      if (!destination) target.closeEmpty()
      throw error
    }
  }

  private render() {
    for (const window of this.windows.values()) window.render()
  }

  async quit() {
    if (this.confirmingQuit) return
    this.confirmingQuit = true
    this.drag.cancel()
    try {
      const panes = [...this.terminals.panes.values()]
      const draft = panes.some(pane => pane.state.hasDraft)
      if (panes.length > 0) {
        const result = await dialog.showMessageBox(this.current!.ensureWindow(), {
          type: 'question',
          message: `Close ${panes.length} terminal panes across ${this.windows.size} windows?`,
          detail: `Local shells will end. Remote sessions keep running.${draft ? ' Unsent messages will be discarded.' : ''}`,
          buttons: ['Quit Outpost', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        })
        if (result.response !== 0) return
      }
      await this.recentSessions.flush()
      // A new launch while confirmation or persistence was pending is not part
      // of the approved shutdown. Leave it open and let the user request quit again.
      if ([...this.terminals.panes.values()].some(pane => !panes.includes(pane))) return
      this.dispose()
      await this.terminals.flushCleanup()
      if (this.terminals.panes.size) return
      this.quitting = true
      app.quit()
    } finally {
      this.confirmingQuit = false
    }
  }
}
