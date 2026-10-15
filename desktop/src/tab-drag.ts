import { screen, type Point } from 'electron'
import type { WorkspaceWindow } from './workspace-window'
import type { TabDragState } from './workspace-api'
import { TabDragPreview } from './tab-drag-preview'

interface Host {
  windows(): WorkspaceWindow[]
  changed(): void
  preview(id: number, target: WorkspaceWindow, before: number | null): { restore(): void }
  drop(source: WorkspaceWindow, id: number, target: WorkspaceWindow | null, before: number | null, point: Point): void
  failed(error: unknown): void
}
interface Drag {
  source: WorkspaceWindow
  id: number
  target: WorkspaceWindow | null
  before: number | null
  scroll: number
  preview: TabDragPreview
  transfer: { restore(): void } | null
  sourceOpacity: number | null
}

/** Hover moves the live view provisionally; release commits, cancellation restores. */
export class TabDrag {
  private drag: Drag | null = null
  private timer?: ReturnType<typeof setInterval>
  constructor(private host: Host) {}

  start(source: WorkspaceWindow, id: number, title: string) {
    this.cancel()
    const preview = new TabDragPreview(title, screen.getCursorScreenPoint())
    this.drag = { source, id, target: null, before: null, scroll: 0, preview, transfer: null, sourceOpacity: null }
    // Native DIP coordinates work outside the source window and while a
    // stationary pointer scrolls a destination's tab strip.
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

  state(window: WorkspaceWindow): TabDragState | null {
    const drag = this.drag
    return drag
      ? {
          id: drag.id,
          source: drag.source === window,
          target: drag.target === window,
          before: drag.before,
          scroll: drag.target === window ? drag.scroll : 0,
        }
      : null
  }

  private restoreOpacity(drag: Drag) {
    const window = drag.source.browserWindow
    if (drag.sourceOpacity !== null && window && !window.isDestroyed()) window.setOpacity(drag.sourceOpacity)
    drag.sourceOpacity = null
  }

  update(source: WorkspaceWindow) {
    const drag = this.drag
    if (!drag || drag.source !== source) return
    const point = screen.getCursorScreenPoint()
    let target: WorkspaceWindow | null = null,
      before: number | null = null
    // moveTop() raises the hover destination without stealing the source's
    // pointer capture. Reflect that temporary native stacking order in hit tests.
    const windows = this.host.windows()
    if (drag.transfer && drag.target) windows.unshift(drag.target)
    for (const candidate of new Set(windows)) {
      const window = candidate.browserWindow
      if (!window || !window.isVisible() || window.isMinimized()) continue
      if (candidate === source && drag.sourceOpacity !== null) continue
      const bounds = window.getBounds()
      if (
        point.x < bounds.x ||
        point.x >= bounds.x + bounds.width ||
        point.y < bounds.y ||
        point.y >= bounds.y + bounds.height
      )
        continue
      const position = candidate.dropAt(point, drag.id)
      if (position !== undefined) {
        target = candidate
        before = position === drag.id && candidate !== source ? drag.before : position
      }
      break // Do not drop through an overlapping Outpost window into one behind it.
    }
    const scroll = target?.scrollAt(point) ?? 0
    const targetChanged = drag.target !== target
    if (targetChanged || drag.before !== before || drag.scroll !== scroll) {
      if (targetChanged && drag.transfer) {
        drag.transfer.restore()
        drag.transfer = null
        if (this.drag !== drag) return
        this.restoreOpacity(drag)
        source.browserWindow?.moveTop()
      }
      drag.target = target
      drag.before = before
      drag.scroll = scroll
      if (target && target !== source) {
        if (!drag.transfer) {
          const transfer = this.host.preview(drag.id, target, before)
          if (this.drag !== drag) {
            transfer.restore()
            return
          }
          drag.transfer = transfer
          if (!source.hasTabs && source.browserWindow) {
            // hide() loses native capture. Opacity hides the empty source while
            // its stable chrome still receives mouse-up and Escape on macOS/Windows.
            drag.sourceOpacity = source.browserWindow.getOpacity()
            source.browserWindow.setOpacity(0)
          }
          if (this.drag !== drag) return
          target.browserWindow?.moveTop()
        } else target.placeTab(drag.id, before)
      }
      this.host.changed()
    }
    if (target) drag.preview.hide()
    else drag.preview.show(point)
  }

  end(source: WorkspaceWindow, cancel: boolean) {
    const drag = this.drag
    if (!drag || drag.source !== source) return
    if (cancel) return this.cancel()
    try {
      this.update(source)
      if (this.drag !== drag) return
      // Leave a hover transfer in place on commit: no bounce through the source
      // view, second load, or extra resize before activating the destination.
      this.drag = null
      clearInterval(this.timer)
      drag.preview.destroy()
      this.host.drop(source, drag.id, drag.target, drag.before, screen.getCursorScreenPoint())
    } catch (error) {
      this.drag = null
      clearInterval(this.timer)
      drag.preview.destroy()
      drag.transfer?.restore()
      throw error
    } finally {
      this.restoreOpacity(drag)
      this.host.changed()
    }
  }
  cancelTab(id: number) {
    if (this.drag?.id === id) this.cancel()
  }
  cancelWindow(window: WorkspaceWindow) {
    if (this.drag?.source === window || this.drag?.target === window) this.cancel()
  }
  cancel() {
    const drag = this.drag
    if (!drag) return
    this.drag = null
    clearInterval(this.timer)
    drag.preview.destroy()
    try {
      drag.transfer?.restore()
    } finally {
      this.restoreOpacity(drag)
      if (drag.source.browserWindow?.isFocused()) {
        drag.source.browserWindow.moveTop()
        drag.source.restoreFocus()
      }
      this.host.changed()
    }
  }
}
