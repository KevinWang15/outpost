import { BrowserWindow, screen, type Point } from 'electron'
import type { WorkspaceWindow } from './workspace-window'
import type { TabDragState } from './workspace-api'

interface Host {
  windows(): WorkspaceWindow[]
  changed(): void
  drop(id: number, target: WorkspaceWindow | null, before: number | null, point: Point): void
}
interface Drag {
  source: WorkspaceWindow
  id: number
  target: WorkspaceWindow | null
  before: number | null
  scroll: number
  preview: BrowserWindow
}

/** A drag changes ownership only on release. Escape/blur/close are cancellations. */
export class TabDrag {
  private drag: Drag | null = null
  private timer?: ReturnType<typeof setInterval>
  constructor(private host: Host) {}

  start(source: WorkspaceWindow, id: number, title: string) {
    this.cancel()
    const point = screen.getCursorScreenPoint()
    const preview = new BrowserWindow({
      x: point.x + 12,
      y: point.y + 16,
      width: 240,
      height: 42,
      frame: false,
      show: false,
      focusable: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      hiddenInMissionControl: true,
      alwaysOnTop: true,
      resizable: false,
      backgroundColor: '#162239',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
    })
    preview.setMenu(null)
    preview.setIgnoreMouseEvents(true)
    const escaped = title.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
    void preview
      .loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            `<meta charset="utf-8"><style>body{margin:0;padding:10px 14px;color:#e2e8f0;background:#162239;font:13px system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid #60a5fa;box-sizing:border-box;height:100vh}</style>${escaped}`,
          ),
      )
      .then(() => {
        if (!preview.isDestroyed()) preview.showInactive()
      })
      .catch(() => {})
    this.drag = { source, id, target: null, before: null, scroll: 0, preview }
    // Native DIP coordinates also work while the pointer is outside the source
    // window and while a stationary pointer scrolls a destination's tab strip.
    this.timer = setInterval(() => this.update(source), 32)
    this.update(source)
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

  update(source: WorkspaceWindow) {
    const drag = this.drag
    if (!drag || drag.source !== source) return
    const point = screen.getCursorScreenPoint()
    drag.preview.setPosition(point.x + 12, point.y + 16)
    let target: WorkspaceWindow | null = null,
      before: number | null = null
    for (const candidate of this.host.windows()) {
      const window = candidate.browserWindow
      if (!window || !window.isVisible() || window.isMinimized()) continue
      const bounds = window.getBounds()
      if (
        point.x < bounds.x ||
        point.x >= bounds.x + bounds.width ||
        point.y < bounds.y ||
        point.y >= bounds.y + bounds.height
      )
        continue
      const position = candidate.dropAt(point)
      if (position !== undefined) {
        target = candidate
        before = position
      }
      break // Do not drop through an overlapping Outpost window into one behind it.
    }
    const scroll = target?.scrollAt(point) ?? 0
    if (drag.target !== target || drag.before !== before || drag.scroll !== scroll) {
      drag.target = target
      drag.before = before
      drag.scroll = scroll
      this.host.changed()
    }
  }

  end(source: WorkspaceWindow, cancel: boolean) {
    const drag = this.drag
    if (!drag || drag.source !== source) return
    if (!cancel) this.update(source)
    const point = screen.getCursorScreenPoint()
    this.cancel()
    if (!cancel) this.host.drop(drag.id, drag.target, drag.before, point)
  }
  cancelTab(id: number) {
    if (this.drag?.id === id) this.cancel()
  }
  cancel() {
    const drag = this.drag
    if (!drag) return
    this.drag = null
    clearInterval(this.timer)
    drag.preview.destroy()
    this.host.changed()
  }
}
