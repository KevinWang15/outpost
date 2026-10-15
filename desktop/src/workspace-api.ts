import type { TerminalPreferences, TerminalTabState } from '../../shared/desktop'

export type WorkspacePanel = 'sessions' | 'switcher' | 'settings' | { rename: number } | null
export type SplitDirection = 'columns' | 'rows'
export interface TabSummary extends TerminalTabState {
  id: number
  origin: string
  label: string
  error: string | null
}
export interface WorkspaceSnapshot {
  version: string
  platform: string
  tabs: TabSummary[]
  active: number | null
  split: { ids: [number, number]; direction: SplitDirection; ratio: number } | null
  panel: WorkspacePanel
  servers: string[]
  preferences: TerminalPreferences
}

/** Local app chrome only. Terminal pages receive the separate DesktopBridge. */
export interface WorkspaceBridge {
  state(): Promise<WorkspaceSnapshot>
  onState(listener: (state: WorkspaceSnapshot) => void): () => void
  activate(id: number): Promise<void>
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
  preferences(value: TerminalPreferences): Promise<void>
  checkUpdates(): Promise<void>
}

export const tabBarHeight = 48
export const statusBarHeight = 28
export const splitGap = 8
