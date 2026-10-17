export type WorkspacePanel = 'sessions' | 'switcher' | 'settings' | { renameTab: number } | null
export type SplitDirection = 'columns' | 'rows'
export type PaneNode =
  | { readonly kind: 'pane'; readonly id: number }
  | {
      readonly kind: 'split'
      readonly id: number
      readonly direction: SplitDirection
      readonly ratio: number
      readonly first: PaneNode
      readonly second: PaneNode
    }
export type WorkspaceItem = { kind: 'tab' | 'pane'; id: number }
export type PanePlacement =
  { kind: 'tab'; before: number | null } | { kind: 'pane'; pane: number; edge: 'left' | 'right' | 'top' | 'bottom' }
/** A tab is a layout container, never a terminal connection. */
export interface TabGroup {
  readonly id: number
  readonly root: PaneNode
  readonly activePaneId: number
  readonly label: string | null
  readonly zoomed: boolean
}
/** Each window selects a tab; each tab remembers its selected pane. */
export interface WindowLayoutState {
  tabs: TabGroup[]
  activeTabId: number | null
  panel: WorkspacePanel
}
export type CloseScope = WorkspaceItem | { kind: 'window' }

/** Captured before an asynchronous session choice; selection may change while it is pending. */
export type SessionTarget = { kind: 'tab' } | { kind: 'split'; tabId: number; paneId: number }
