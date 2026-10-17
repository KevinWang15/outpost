import { paneIds } from './layout'
import type { TabGroup, WindowLayoutState, WorkspaceItem, PanePlacement } from './workspace-model'
export interface PaneTransferWindow {
  captureLayout(): WindowLayoutState
  restoreLayout(state: WindowLayoutState): void
  selection(item: WorkspaceItem): number[]
  extract(item: WorkspaceItem): TabGroup
  insert(group: TabGroup, placement: PanePlacement): void
  attach(id: number): boolean
  detach(id: number): void
  groupForPane(id: number): number | undefined
  render(): void
}

/** Move layout ownership and native views as one transaction. Hover cancellation
 * restores both trees, selection and panels; no PTY, renderer or draft is recreated. */
export function transferPanes<Window extends PaneTransferWindow>(
  item: WorkspaceItem,
  source: Window,
  target: Window,
  placement: PanePlacement,
  own: (id: number, window: Window) => void,
) {
  const sourceState = source.captureLayout(),
    targetState = target.captureLayout()
  const ids = source.selection(item)
  if (!ids.length) throw new Error('This terminal is no longer available.')
  if (placement.kind === 'pane' && ids.includes(placement.pane)) throw new Error('A pane cannot be split into itself.')
  // Extracting a whole tab removes its own insertion anchor.
  if (source === target && placement.kind === 'tab' && placement.before !== null) {
    const before = placement.before
    const anchor = sourceState.tabs.findIndex(tab => tab.id === before)
    if (anchor >= 0 && paneIds(sourceState.tabs[anchor].root).every(id => ids.includes(id)))
      placement = { kind: 'tab', before: sourceState.tabs[anchor + 1]?.id ?? null }
  }
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    if (source !== target) {
      for (const id of ids) {
        target.detach(id)
        own(id, source)
        source.attach(id)
      }
      target.restoreLayout(targetState)
    }
    source.restoreLayout(sourceState)
  }
  try {
    const group = source.extract(item)
    target.insert(group, placement)
    if (source !== target) {
      for (const id of ids) {
        source.detach(id)
        own(id, target)
        if (!target.attach(id)) throw new Error('This terminal has closed.')
      }
    }
    source.render()
    if (source !== target) target.render()
    return { restore, tabId: target.groupForPane(group.activePaneId)!, activePaneId: group.activePaneId }
  } catch (error) {
    restore()
    throw error
  }
}
