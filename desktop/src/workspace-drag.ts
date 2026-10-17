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
interface Drag {
  source: WorkspaceWindow
  item: WorkspaceItem
  panes: number[]
  target: WorkspaceWindow | null
  placement: PanePlacement
  blocked: boolean
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
      target: null,
      placement: { kind: 'tab', before: null },
      blocked: false,
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
    return drag
      ? {
          id: drag.transfer && window === drag.target ? drag.transfer.tabId : drag.item.id,
          kind: drag.transfer && window === drag.target ? 'tab' : drag.item.kind,
          source: drag.source === window,
          target: drag.target === window && drag.placement.kind === 'tab',
          before: drag.placement.kind === 'tab' ? drag.placement.before : null,
          scroll: drag.target === window ? drag.scroll : 0,
        }
      : null
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
  update(source: WorkspaceWindow) {
    const drag = this.drag
    if (!drag || drag.source !== source) return
    const point = screen.getCursorScreenPoint()
    let candidate: WorkspaceWindow | null = null
    const windows = this.host.windows()
    if (drag.transfer && drag.target) windows.unshift(drag.target)
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
    if (before !== undefined && before === drag.transfer?.tabId && drag.placement.kind === 'tab')
      before = drag.placement.before
    if (drag.transfer && (candidate !== drag.target || before === undefined)) this.restoreTransfer(drag)
    if (this.drag !== drag) return
    let target: WorkspaceWindow | null = null
    let placement: PanePlacement = { kind: 'tab', before: null }
    let highlight: Rectangle | null = null
    if (candidate && before !== undefined) {
      target = candidate
      placement = { kind: 'tab', before }
    } else if (candidate) {
      const drop = candidate.paneDropAt(point, drag.panes)
      if (drop) {
        target = candidate
        placement = drop.placement
        highlight = drop.bounds
      }
    }
    const scroll = target && placement.kind === 'tab' ? target.scrollAt(point) : 0
    const changed =
      drag.target !== target ||
      JSON.stringify(drag.placement) !== JSON.stringify(placement) ||
      drag.scroll !== scroll ||
      drag.blocked !== (!!candidate && !target)
    drag.target = target
    drag.placement = placement
    drag.blocked = !!candidate && !target
    drag.scroll = scroll
    if (target && target !== source && placement.kind === 'tab') {
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
    if (highlight) drag.preview.highlight(highlight)
    else if (target || drag.blocked) drag.preview.hide()
    else drag.preview.show(point)
    if (changed) this.host.changed()
  }
  end(source: WorkspaceWindow, cancel: boolean) {
    const drag = this.drag
    if (!drag || drag.source !== source) return
    if (cancel) return this.cancel()
    try {
      this.update(source)
      if (this.drag !== drag) return
      if (drag.blocked) return this.cancel()
      this.drag = null
      clearInterval(this.timer)
      drag.preview.destroy()
      if (drag.transfer && drag.target) this.host.committed(source, drag.target, drag.transfer.activePaneId)
      else this.host.drop(source, drag.item, drag.target, drag.placement, screen.getCursorScreenPoint())
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
    return this.drag?.source === window || this.drag?.target === window ? this.cancel() : false
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
