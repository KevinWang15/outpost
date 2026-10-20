import { app, BrowserWindow, dialog, ipcMain, screen, type Point } from 'electron'
import {
  desktopSessionId,
  type DesktopLaunch,
  type DesktopSessionReference,
  type DesktopSessionChoice,
} from '../../shared/desktopAuth'
import { Preferences } from './preferences'
import { TerminalPanes, type TerminalPane } from './terminals'
import { RecentSessions } from './recent-sessions'
import { SessionFinder } from './session-finder'
import { SessionCreator } from './session-creator'
import { ServerAccounts } from './server-accounts'
import { WorkspaceDrag } from './workspace-drag'
import { transferPanes } from './pane-transfer'
import type { WorkspaceItem, PanePlacement, SessionTarget } from './workspace-model'
import { WorkspaceWindow } from './workspace-window'
import { shellProfiles } from './shell-profiles'

type OpenDestination =
  { kind: 'activate'; window?: WorkspaceWindow } | { kind: 'place'; window: WorkspaceWindow; placement: PanePlacement }

/** App-wide pane identity and window ownership; transfers preserve terminal views. */
export class DesktopWorkspace {
  readonly shells = shellProfiles()
  private windows = new Map<number, WorkspaceWindow>()
  private owners = new Map<number, WorkspaceWindow>()
  private recent: number[] = []
  private terminals: TerminalPanes
  private drag: WorkspaceDrag
  private finder: SessionFinder
  private creator: SessionCreator
  private lifecycle: 'running' | 'confirming' | 'closing' | 'closed' = 'running'
  get stopping() {
    return this.lifecycle === 'closing' || this.lifecycle === 'closed'
  }
  get quitting() {
    return this.lifecycle === 'closed'
  }

  constructor(
    private directory: string,
    private preferences: Preferences,
    private recentSessions: RecentSessions,
    private accounts: ServerAccounts,
  ) {
    this.finder = new SessionFinder(directory)
    this.creator = new SessionCreator(directory)
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
        if (!this.accounts.hasAccount(entry.server, entry.accountId)) return
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
      if (this.stopping) return
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
    if (this.stopping) return
    this.terminals.resume()
    void this.accounts.refresh()
  }
  accountsChanged() {
    this.render()
  }
  edit(action: 'copy' | 'paste' | 'select-all') {
    if (this.creator.edit(action) || this.finder.edit(action)) return
    const owner = this.forAction()
    if (action === 'select-all') owner?.command(action)
    else owner?.edit(action)
  }
  forAction() {
    if (this.stopping || this.creator.focused) return null
    // Menu/OS actions finish any provisional drag before resolving ownership.
    this.drag.cancel()
    return this.current
  }
  show() {
    if (this.stopping || this.creator.focused) return
    const window = this.forAction() ?? this.create()
    if (!window.hasTabs) this.newLocal(undefined, window)
    else window.show()
  }
  present() {
    if (this.stopping || this.creator.focused) return
    const window = this.forAction() ?? this.create()
    window.show()
  }
  newWindow() {
    if (this.stopping || this.creator.focused) return
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
    const workspace = new WorkspaceWindow(this.directory, this.preferences, this.terminals, {
      quitting: () => this.stopping,
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
      newLocal: (source, profile, placement) => this.newLocal(profile, source, placement),
      recentSessions: () =>
        this.recentSessions.list().filter(item => {
          const entry = this.recentSessions.get(item.id)!
          return this.accounts.hasAccount(entry.server, entry.accountId)
        }),
      openRecent: (source, id) => this.openRecent(source, id),
      findSession: (source, target, anchor, server) => this.findSession(source, target, anchor, server),
      serverAccounts: () => this.accounts.snapshot(),
      loginServer: origin => this.accounts.login(origin),
      cancelServerLogin: origin => this.accounts.cancel(origin),
      logoutServer: async origin => {
        if (!(await this.accounts.logout(origin))) return
        for (const entry of this.recentSessions.list())
          if (entry.server === origin) this.terminals.forgetRecent(entry.id)
        await this.recentSessions.retain(entry => entry.server !== origin)
        this.render()
      },
      refreshServers: () => this.accounts.refresh(),
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
        if (this.stopping || !ids.length || !source.browserWindow?.isFocused()) return
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
    if (this.stopping) return
    this.drag.cancel()
    return this.activateOpened(this.terminals.open(launch))
  }

  private async openRecent(source: WorkspaceWindow, id: string) {
    const entry = this.recentEntry(id)
    this.drag.cancel()
    const launch = await this.accounts.launch(entry)
    if (this.stopping || !source.browserWindow || source.browserWindow.isDestroyed()) return
    return this.activateOpened(this.terminals.open(launch), { kind: 'activate', window: source })
  }

  private recentEntry(id: string) {
    const entry = this.recentSessions.get(id)
    if (!entry || !this.accounts.hasAccount(entry.server, entry.accountId))
      throw new Error('This recent session is no longer available.')
    return entry
  }

  private async findSession(source: WorkspaceWindow, target: SessionTarget, anchor: Point, server?: string) {
    this.drag.cancel()
    const window = source.browserWindow
    if (!window || window.isDestroyed()) return
    const anchorPane = target.kind === 'split' ? this.terminals.panes.get(target.paneId) : undefined
    const excluded = anchorPane?.connection.kind === 'remote' ? desktopSessionId(anchorPane.connection.reference) : null
    try {
      await this.finder.pick(
        window,
        target.kind === 'split' ? 'Split with Outpost terminal' : 'Open Outpost terminal',
        anchor,
        {
          load: (signal, publish, previous) =>
            this.accounts.sessions(
              signal,
              ({ sessions, errors }) =>
                publish({
                  sessions: sessions.filter(session => desktopSessionId(session) !== excluded),
                  errors,
                }),
              previous,
            ),
          create: parent => this.createSession(source, target, parent, server),
          open: (session, signal) => this.openSessionAt(source, target, session, signal),
        },
      )
    } finally {
      source.restoreFocus()
    }
  }

  private async createSession(
    source: WorkspaceWindow,
    target: SessionTarget,
    parent: BrowserWindow,
    server?: string,
  ): Promise<DesktopSessionChoice | null> {
    this.drag.cancel()
    const window = source.browserWindow
    if (!window || window.isDestroyed() || this.stopping) return null
    const anchor = target.kind === 'split' ? this.terminals.panes.get(target.paneId) : undefined
    const reference = anchor?.connection.kind === 'remote' ? anchor.connection.reference : undefined
    const servers = this.accounts.creationServers()
    const defaultServer = server ?? reference?.server
    if (defaultServer && !servers.some(item => item.summary.origin === defaultServer))
      throw new Error('Sign in to this server from the Outpost tab before creating a session.')
    return this.creator.pick(
      parent,
      servers,
      { server: defaultServer, targetId: server ? undefined : reference?.targetId },
      () => this.sessionPlacement(source, target),
    )
  }

  /** Resolve the captured destination, never the tab selected after an async dialog. */
  private sessionPlacement(source: WorkspaceWindow, target: SessionTarget): PanePlacement {
    const window = source.browserWindow
    if (this.stopping || !window || window.isDestroyed() || this.windows.get(window.id) !== source)
      throw new Error('The destination window has closed.')
    if (target.kind === 'split' && source.groupForPane(target.paneId) !== target.tabId)
      throw new Error('The pane chosen for this split has moved or closed. Start again from its tab.')
    return target.kind === 'split'
      ? { kind: 'pane', pane: target.paneId, edge: 'right' }
      : { kind: 'tab', before: null }
  }

  private async openSessionAt(
    source: WorkspaceWindow,
    target: SessionTarget,
    session: DesktopSessionReference,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted()
    if (this.stopping || !source.browserWindow || source.browserWindow.isDestroyed()) return
    this.sessionPlacement(source, target)
    const launch = await this.accounts.launch(session, signal)
    signal.throwIfAborted()
    if (this.stopping || !source.browserWindow || source.browserWindow.isDestroyed()) return
    this.drag.cancel()
    const placement = this.sessionPlacement(source, target)
    await this.activateOpened(this.terminals.open(launch), { kind: 'place', window: source, placement })
  }

  private async activateOpened(
    { pane, created }: { pane: TerminalPane; created: boolean },
    destination: OpenDestination = { kind: 'activate' },
  ) {
    let owner = this.owners.get(pane.id)
    if (created) {
      owner = this.attachNewPane(
        pane,
        destination.window,
        destination.kind === 'place' ? destination.placement : undefined,
      )
    }
    if (!owner) throw new Error('This terminal is no longer available.')
    if (!created && destination.kind === 'place')
      this.move(owner, { kind: 'pane', id: pane.id }, destination.window, destination.placement)
    else owner.activatePane(pane.id)
    if (!created && pane.state.connection === 'connected') await this.terminals.remember(pane)
  }

  newLocal(profileId?: string, destination?: WorkspaceWindow, placement?: PanePlacement) {
    if (this.stopping || this.creator.focused) return
    this.drag.cancel()
    const profile =
      this.shells.find(item => item.id === (profileId ?? this.preferences.localShell)) ??
      (profileId === undefined ? this.shells[0] : undefined)
    if (!profile) throw new Error('Choose an available local shell.')
    const pane = this.terminals.openLocal(profile)
    const owner = this.attachNewPane(pane, destination, placement)
    owner.activatePane(pane.id)
  }

  private attachNewPane(pane: TerminalPane, destination?: WorkspaceWindow, placement?: PanePlacement) {
    let owner = destination ?? this.current
    try {
      owner ??= this.create()
      this.owners.set(pane.id, owner)
      owner.addPane(pane, placement)
      return owner
    } catch (error) {
      this.terminals.dispose(pane.id)
      owner?.closeEmpty()
      throw error
    }
  }

  dispose() {
    this.finder.cancel()
    this.creator.cancel()
    this.accounts.dispose()
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
    if (!ids.length || !source.browserWindow || this.stopping) return
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
    if (this.lifecycle !== 'running') return
    this.lifecycle = 'confirming'
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
      await this.accounts.flush()
      // A new launch while confirmation or persistence was pending is not part
      // of the approved shutdown. Leave it open and let the user request quit again.
      if ([...this.terminals.panes.values()].some(pane => !panes.includes(pane))) return
      // Closing is irreversible: reject new work while saving committed logins
      // and draining PTY cleanup. Only then allow Electron's final quit event.
      this.lifecycle = 'closing'
      this.creator.cancel()
      await this.creator.flush()
      this.dispose()
      await this.accounts.flush()
      await this.terminals.flushCleanup()
      this.lifecycle = 'closed'
      app.quit()
    } finally {
      if (this.lifecycle === 'confirming') this.lifecycle = 'running'
    }
  }
}
