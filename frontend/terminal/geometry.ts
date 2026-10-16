import type { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { terminalService } from '../../shared/terminalService'
import { refreshTerminalMetrics } from '../../shared/terminalCheckpoint'

/** Measure the local viewport; only the ordered connection stream resizes the
 * terminal buffer. Cell metrics can change without a container resize (DPI,
 * fonts or GPU fallback), so observe the screen as well as its container. */
export class TerminalGeometry {
  private fit = new FitAddon()
  private observer: ResizeObserver
  private display: MediaQueryList
  private frame = 0
  private repaint = false
  private disposed = false
  private last = { cols: 80, rows: 24 }

  constructor(
    private terminal: Terminal,
    private surface: HTMLElement,
    private resize: (cols: number, rows: number) => void,
  ) {
    terminal.loadAddon(this.fit)
    this.observer = new ResizeObserver(() => this.refresh())
    this.observer.observe(surface)
    const screen = terminal.element?.querySelector('.xterm-screen')
    if (screen) this.observer.observe(screen)
    this.display = this.watchDisplay()
    window.addEventListener('focus', this.activate)
    window.addEventListener('pageshow', this.activate)
    document.addEventListener('visibilitychange', this.activate)
    document.fonts.addEventListener('loadingdone', this.activate)
    void document.fonts.ready.then(() => this.refresh(true))
  }

  private measure() {
    // Hidden or not-yet-laid-out views keep their last valid size. Sending an
    // arbitrary 80x24 here can truncate a fullscreen application's screen.
    if (!this.surface.clientWidth || !this.surface.clientHeight) return
    const size = this.fit.proposeDimensions()
    if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return
    this.last = {
      cols: Math.max(2, Math.min(terminalService.maxCols, size.cols)),
      rows: Math.max(2, Math.min(terminalService.maxRows, size.rows)),
    }
    return this.last
  }

  size = () => this.measure() ?? this.last

  refresh(repaint = false) {
    if (this.disposed) return
    this.repaint ||= repaint
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      if (this.repaint) refreshTerminalMetrics(this.terminal)
      const size = this.measure()
      if (!size) return
      this.resize(size.cols, size.rows)
      if (this.repaint) {
        this.repaint = false
        this.terminal.refresh(0, this.terminal.rows - 1)
      }
    })
  }

  private activate = () => {
    if (document.visibilityState === 'visible') this.refresh(true)
  }

  private watchDisplay() {
    const display = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    display.addEventListener('change', this.displayChanged)
    return display
  }

  private displayChanged = () => {
    this.display.removeEventListener('change', this.displayChanged)
    this.display = this.watchDisplay()
    this.refresh(true)
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.observer.disconnect()
    this.display.removeEventListener('change', this.displayChanged)
    window.removeEventListener('focus', this.activate)
    window.removeEventListener('pageshow', this.activate)
    document.removeEventListener('visibilitychange', this.activate)
    document.fonts.removeEventListener('loadingdone', this.activate)
    this.fit.dispose()
  }
}
