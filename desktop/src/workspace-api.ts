import type { TerminalPreferences, TerminalTabState } from '../../shared/desktop'
import type { ShellProfileSummary } from '../../shared/localTerminal'
import type { RecentSessionSummary } from './recent-sessions'

export type WorkspacePanel = 'sessions' | 'switcher' | 'settings' | { rename: number } | null
export type SplitDirection = 'columns' | 'rows'
export interface TabSummary extends TerminalTabState {
  kind: 'local' | 'remote'
  id: number
  origin: string
  label: string
  error: string | null
}
export interface TabGeometry {
  left: number
  right: number
  viewportRight: number
  tabs: { id: number; left: number; right: number }[]
}
export interface TabDragState {
  id: number
  source: boolean
  target: boolean
  before: number | null
  scroll: number
}
export interface WorkspaceSnapshot {
  version: string
  platform: string
  tabs: TabSummary[]
  active: number | null
  split: { ids: [number, number]; direction: SplitDirection; ratio: number } | null
  panel: WorkspacePanel
  servers: string[]
  recentSessions: RecentSessionSummary[]
  preferences: TerminalPreferences
  shells: ShellProfileSummary[]
  defaultShell: string
  drag: TabDragState | null
}

/** Local app chrome only. Terminal pages receive the separate DesktopBridge. */
export interface WorkspaceBridge {
  newLocal(profile?: string): Promise<void>
  shellMenu(): Promise<void>
  tabGeometry(value: TabGeometry): Promise<void>
  dragStart(id: number): Promise<void>
  dragEnd(cancel: boolean): Promise<void>
  state(): Promise<WorkspaceSnapshot>
  onState(listener: (state: WorkspaceSnapshot) => void): () => void
  /** Pointer presses select immediately, deferring terminal focus until release. */
  activate(id: number, focusTerminal?: boolean): Promise<void>
  close(id: number): Promise<void>
  reorder(id: number, before: number | null): Promise<void>
  rename(id: number, label: string): Promise<void>
  panel(panel: WorkspacePanel): Promise<void>
  pair(id: number): Promise<void>
  split(direction: SplitDirection | null): Promise<void>
  ratio(value: number): Promise<void>
  contextMenu(id: number): Promise<void>
  reload(id: number): Promise<void>
  openServer(origin: string): Promise<boolean>
  forgetServer(origin: string): Promise<void>
  openRecent(id: string): Promise<void>
  removeRecent(id: string): Promise<void>
  clearRecent(): Promise<void>
  preferences(value: TerminalPreferences, shell: string): Promise<void>
  checkUpdates(): Promise<void>
  reportError(message: string): Promise<void>
}

export const tabBarHeight = 36
export const splitGap = 8
