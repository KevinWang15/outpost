import { BrowserWindow, type Point, type Rectangle } from 'electron'
import { tabBarHeight } from './layout'

const size = { width: 240, height: tabBarHeight }

/** A native, click-through drag label or split preview above terminal views.
 * Bounds come from geometry, never from measuring this popup. */
export class DragPreview {
  private window: BrowserWindow
  private ready = false
  private visible = false
  private bounds: Rectangle | null = null

  constructor(title: string, point: Point) {
    const window = new BrowserWindow({
      x: point.x + 12,
      y: point.y + 16,
      ...size,
      frame: false,
      // Windows' invisible resize insets must not participate in this popup's
      // bounds. In particular, never move it by reading back its native size.
      thickFrame: false,
      hasShadow: false,
      roundedCorners: false,
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
    this.window = window
    window.setMenu(null)
    window.setIgnoreMouseEvents(true)
    const escaped = title.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
    void window
      .loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            `<meta charset="utf-8"><style>html,body{margin:0;overflow:hidden;height:100%}body{padding:0 12px;color:#e2e8f0;background:#162239;font:13px/${size.height - 2}px system-ui;white-space:nowrap;text-overflow:ellipsis;border:1px solid #60a5fa;box-sizing:border-box}</style>${escaped}`,
          ),
      )
      .then(() => {
        this.ready = true
        if (this.visible && !window.isDestroyed()) window.showInactive()
      })
      .catch(() => {})
  }

  private place(bounds: Rectangle, opacity: number) {
    const window = this.window
    if (window.isDestroyed()) return
    if (
      !this.bounds ||
      Object.keys(bounds).some(key => bounds[key as keyof Rectangle] !== this.bounds![key as keyof Rectangle])
    ) {
      window.setBounds(bounds, false)
      this.bounds = bounds
    }
    if (window.getOpacity() !== opacity) window.setOpacity(opacity)
    this.visible = true
    if (this.ready && !window.isVisible()) window.showInactive()
  }
  show(point: Point) {
    this.place({ x: point.x + 12, y: point.y + 16, ...size }, 1)
  }
  highlight(bounds: Rectangle) {
    this.place(bounds, 0.65)
  }
  hide() {
    this.visible = false
    if (!this.window.isDestroyed() && this.window.isVisible()) this.window.hide()
  }
  destroy() {
    this.visible = false
    if (!this.window.isDestroyed()) this.window.destroy()
  }
}
