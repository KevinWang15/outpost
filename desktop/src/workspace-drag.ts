import { screen, type Point, type Rectangle } from 'electron'
import type { WorkspaceWindow } from './workspace-window'
import type { WorkspaceDragState } from './workspace-api'
import type { WorkspaceItem, PanePlacement } from './workspace-model'
import { DragPreview } from './drag-preview'

interface Transfer {
  restore(): void
  tabId: number
  activePaneId: number
}
interface Host {
  windows(): WorkspaceWindow[]
  changed(): void
  preview(source: WorkspaceWindow, item: WorkspaceItem, target: WorkspaceWindow, before: number | null): Transfer
  drop(
    source: WorkspaceWindow,
    item: WorkspaceItem,
    target: WorkspaceWindow | null,
    placement: PanePlacement,
    point: Point,
  ): void
  committed(source: WorkspaceWindow, target: WorkspaceWindow, activePaneId: number): void
  failed(error: unknown): void
}
type DropDestination =
  | { kind: 'place'; target: WorkspaceWindow; placement: PanePlacement; highlight: Rectangle | null }
  | { kind: 'detach' }
  | { kind: 'cancel' }
interface Drag {
  source: WorkspaceWindow
  item: WorkspaceItem
  panes: number[]
  destination: DropDestination
  scroll: number
  preview: DragPreview
  transfer: Transfer | null
  sourceOpacity: number | null
}

/** Tab-bar hover previews the live terminal; pane edges preview their destination
 * without resizing terminals during hit testing. Both commit through one transfer. */
export class WorkspaceDrag {
  private drag: Drag | null = null
  private timer?: ReturnType<typeof setInterval>
  constructor(private host: Host) {}

  start(source: WorkspaceWindow, item: WorkspaceItem, title: string) {
    this.cancel()
    this.drag = {
      source,
      item,
      panes: source.selection(item),
      destination: { kind: 'cancel' },
      scroll: 0,
      preview: new DragPreview(title, screen.getCursorScreenPoint()),
      transfer: null,
      sourceOpacity: null,
    }
    const update = () => {
      try {
        this.update(source)
      } catch (error) {
        this.cancel()
        this.host.failed(error)
      }
    }
    this.timer = setInterval(update, 32)
    update()
    this.host.changed()
  }
  state(window: WorkspaceWindow): WorkspaceDragState | null {
    const drag = this.drag
    if (!drag) return null
    const destination = drag.destination.kind === 'place' ? drag.destination : null
    const target = destination?.target === window
    return {
      id: drag.transfer && target ? drag.transfer.tabId : drag.item.id,
      kind: drag.transfer && target ? 'tab' : drag.item.kind,
      source: drag.source === window,
      target: target && destination?.placement.kind === 'tab',
      before: destination?.placement.kind === 'tab' ? destination.placement.before : null,
      scroll: target ? drag.scroll : 0,
    }
  }
  private restoreOpacity(drag: Drag) {
    const window = drag.source.browserWindow
    if (drag.sourceOpacity !== null && window && !window.isDestroyed()) window.setOpacity(drag.sourceOpacity)
    drag.sourceOpacity = null
  }
  private restoreTransfer(drag: Drag) {
    const transfer = drag.transfer
    drag.transfer = null
    transfer?.restore()
    this.restoreOpacity(drag)
  }
  private resolveDestination(
    drag: Drag,
    candidate: WorkspaceWindow | null,
    point: Point,
    before: number | null | undefined,
  ): DropDestination {
    if (!candidate) return { kind: 'detach' }
    // Both handles can create/reorder tabs; a tab-bar destination takes priority.
    if (before !== undefined)
      return { kind: 'place', target: candidate, placement: { kind: 'tab', before }, highlight: null }
    const pane = candidate.paneDropAt(point)
    if (!pane) return { kind: 'cancel' }
    if (drag.panes.includes(pane.placement.pane)) {
      // The tab title moves its whole layout, regardless of pane count.
      // A pane header dropped back onto itself leaves that layout alone.
      return { kind: candidate === drag.source && drag.item.kind === 'tab' ? 'detach' : 'cancel' }
    }
    return { kind: 'place', target: candidate, placement: pane.placement, highlight: pane.bounds }
  }
  update(source: WorkspaceWindow) {
    const drag = this.drag
    if (!drag || drag.source !== source) return
    const point = screen.getCursorScreenPoint()
    const previous = drag.destination
    const previousTarget = previous.kind === 'place' ? previous.target : null
    let candidate: WorkspaceWindow | null = null
    const windows = this.host.windows()
    if (drag.transfer && previousTarget) windows.unshift(previousTarget)
    for (const item of new Set(windows)) {
      const window = item.browserWindow
      if (!window || !window.isVisible() || window.isMinimized() || (item === source && drag.sourceOpacity !== null))
        continue
      const b = window.getBounds()
      if (point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height) {
        candidate = item
        break
      }
    }
    let before = candidate?.dropAt(point, drag.transfer?.tabId ?? (drag.item.kind === 'tab' ? drag.item.id : undefined))
    // A provisional tab changes flex widths; its own hit region keeps the same anchor.
    if (
      before !== undefined &&
      before === drag.transfer?.tabId &&
      previous.kind === 'place' &&
      previous.placement.kind === 'tab'
    )
      before = previous.placement.before
    if (drag.transfer && (candidate !== previousTarget || before === undefined)) this.restoreTransfer(drag)
    if (this.drag !== drag) return
    const destination = this.resolveDestination(drag, candidate, point, before)
    const scroll =
      destination.kind === 'place' && destination.placement.kind === 'tab' ? destination.target.scrollAt(point) : 0
    const changed =
      previous.kind !== destination.kind ||
      (previous.kind === 'place' &&
        destination.kind === 'place' &&
        (previous.target !== destination.target ||
          JSON.stringify(previous.placement) !== JSON.stringify(destination.placement))) ||
      drag.scroll !== scroll
    drag.destination = destination
    drag.scroll = scroll
    if (destination.kind === 'place' && destination.target !== source && destination.placement.kind === 'tab') {
      const { target, placement } = destination
      if (!drag.transfer) {
        drag.transfer = this.host.preview(source, drag.item, target, placement.before)
        if (!source.hasTabs && source.browserWindow) {
          // Keep native pointer capture in the source's stable chrome until release.
          drag.sourceOpacity = source.browserWindow.getOpacity()
          source.browserWindow.setOpacity(0)
        }
        target.browserWindow?.moveTop()
      } else target.placeTab(drag.transfer.tabId, placement.before)
    }
    if (destination.kind === 'place' && destination.highlight) drag.preview.highlight(destination.highlight)
    else if (destination.kind === 'detach') drag.preview.show(point)
    else drag.preview.hide()
    if (changed) this.host.changed()
  }
  end(source: WorkspaceWindow, cancel: boolean) {
    const drag = this.drag
    if (!drag || drag.source !== source) return
    if (cancel) return this.cancel()
    try {
      this.update(source)
      if (this.drag !== drag) return
      const destination = drag.destination
      if (destination.kind === 'cancel') return this.cancel()
      this.drag = null
      clearInterval(this.timer)
      drag.preview.destroy()
      if (destination.kind === 'place') {
        if (drag.transfer) this.host.committed(source, destination.target, drag.transfer.activePaneId)
        else this.host.drop(source, drag.item, destination.target, destination.placement, screen.getCursorScreenPoint())
      } else this.host.drop(source, drag.item, null, { kind: 'tab', before: null }, screen.getCursorScreenPoint())
    } catch (error) {
      this.drag = null
      clearInterval(this.timer)
      drag.preview.destroy()
      this.restoreTransfer(drag)
      throw error
    } finally {
      this.restoreOpacity(drag)
      this.host.changed()
    }
  }
  cancelWindow(window: WorkspaceWindow) {
    const drag = this.drag
    return drag?.source === window || (drag?.destination.kind === 'place' && drag.destination.target === window)
      ? this.cancel()
      : false
  }
  cancel() {
    const drag = this.drag
    if (!drag) return false
    this.drag = null
    clearInterval(this.timer)
    drag.preview.destroy()
    try {
      this.restoreTransfer(drag)
    } finally {
      if (drag.source.browserWindow?.isFocused()) {
        drag.source.browserWindow.moveTop()
        drag.source.restoreFocus()
      }
      this.host.changed()
    }
    return true
  }
}
