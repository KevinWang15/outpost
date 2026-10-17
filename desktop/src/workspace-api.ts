import type { TerminalPreferences, TerminalPaneState } from '../../shared/desktop'
import type { ShellProfileSummary } from '../../shared/localTerminal'
import type { RecentSessionSummary } from './recent-sessions'
import type { WorkspacePanel, PaneNode, SplitDirection, WorkspaceItem } from './workspace-model'

export interface PaneSummary extends TerminalPaneState {
  kind: 'local' | 'remote'
  id: number
  origin: string
  label: string
  error: string | null
}
export type PaneStatus = Pick<PaneSummary, 'kind' | 'connection' | 'activity' | 'attention'>
/** Tabs own layout and aggregate presentation, never a terminal connection. */
export interface TabSummary {
  id: number
  label: string
  activePaneId: number
  panes: number[]
  status: PaneStatus
  hasDraft: boolean
}
export interface TabGeometry {
  left: number
  right: number
  viewportRight: number
  tabs: { id: number; left: number; right: number }[]
}
export interface WorkspaceDragState {
  id: number
  kind: WorkspaceItem['kind']
  source: boolean
  target: boolean
  before: number | null
  scroll: number
}
export interface WorkspaceSnapshot {
  version: string
  platform: string
  tabs: TabSummary[]
  panes: PaneSummary[]
  activePaneId: number | null
  activeTabId: number | null
  tree: PaneNode | null
  zoomed: boolean
  panel: WorkspacePanel
  servers: string[]
  recentSessions: RecentSessionSummary[]
  preferences: TerminalPreferences
  shells: ShellProfileSummary[]
  defaultShell: string
  drag: WorkspaceDragState | null
}

/** Local app chrome only. Terminal pages receive the separate DesktopBridge. */
export interface WorkspaceBridge {
  newLocal(profile?: string): Promise<void>
  shellMenu(): Promise<void>
  tabGeometry(value: TabGeometry): Promise<void>
  dragStart(item: WorkspaceItem): Promise<void>
  dragEnd(cancel: boolean): Promise<void>
  state(): Promise<WorkspaceSnapshot>
  onState(listener: (state: WorkspaceSnapshot) => void): () => void
  /** Pointer presses select immediately, deferring terminal focus until release. */
  activateTab(id: number, focusTerminal?: boolean): Promise<void>
  activatePane(id: number, focusTerminal?: boolean): Promise<void>
  closeTab(id: number): Promise<void>
  closePane(id: number): Promise<void>
  paneMenu(id: number): Promise<void>
  renameTab(id: number, label: string): Promise<void>
  panel(panel: WorkspacePanel): Promise<void>
  movePaneBeside(id: number, anchor: number): Promise<void>
  splitPane(id: number, direction: SplitDirection): Promise<void>
  zoomPane(id: number): Promise<void>
  resizeSplit(id: number, value: number): Promise<void>
  tabMenu(id: number): Promise<void>
  reloadPane(id: number): Promise<void>
  openServer(origin: string): Promise<boolean>
  forgetServer(origin: string): Promise<void>
  openRecent(id: string): Promise<void>
  removeRecent(id: string): Promise<void>
  clearRecent(): Promise<void>
  preferences(value: TerminalPreferences, shell: string): Promise<void>
  checkUpdates(): Promise<void>
  reportError(message: string): Promise<void>
}

export type WorkspaceCommands = Omit<WorkspaceBridge, 'onState'>
export type WorkspaceCommand = {
  [Name in keyof WorkspaceCommands]: { name: Name; args: Parameters<WorkspaceCommands[Name]> }
}[keyof WorkspaceCommands]
