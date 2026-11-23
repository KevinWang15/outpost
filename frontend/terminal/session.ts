import type { ImagePasteMode } from '../../shared/terminalFiles'
import { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { imageProblem } from '../../shared/images'
import { browserUrl } from '../../shared/signals'
import { terminalService } from '../../shared/terminalService'
import { clearScreenShortcut } from '../../shared/terminalShortcuts'
import { terminalTheme } from '../../shared/terminalTheme'
import type { HarnessId } from '../../shared/harnesses'
import { touchInput } from '../browser'
import { TerminalActivity } from './activity'
import { attachBell } from './bell'
import { openBrowserTab } from './browser'
import { attachClipboard } from './clipboard'
import type { TerminalState } from './connection'
import { TerminalGeometry } from './geometry'
import { terminalKey, type TerminalModifiers } from './keys'
import { attachTerminalLinks } from './links'
import { TerminalRenderer } from './rendering'
import { TerminalSocket } from './socket'
import { attachTouchScroll } from './touch'

interface SessionOptions {
  surface: HTMLElement
  container: HTMLElement
  title: string
  token: string
  state(value: TerminalState): void
  deliveries(waiting: number): void
  titleChanged(value: string): void
  toolChanged(value: HarnessId): void
  bellChanged(value: boolean): void
  modifiersChanged(value: TerminalModifiers): void
  notice(message: string, sticky?: boolean): void
  blockedLink(url: string): void
  filesChanged(): void
  showComposer(): void
  focusRecovery(): boolean
  attachSearch(term: Terminal, container: HTMLElement): () => void
  bufferChanged(): void
}

/** Owns one terminal's imperative lifetime. React owns presentation and drafts;
 * connections own delivery. Every acquired resource has a paired cleanup here,
 * including when initialization fails before a connection can be opened. */
export class TerminalSession {
  readonly terminal: Terminal
  readonly connection: TerminalSocket
  readonly clipboard: ReturnType<typeof attachClipboard>
  readonly bells: ReturnType<typeof attachBell>
  private geometry: TerminalGeometry
  private activity: TerminalActivity
  private info: { id: string; name: string }
  private modifiers: TerminalModifiers = {}
  private cleanups: (() => void)[] = []
  private disposed = false
  private clearing = false

  constructor(private options: SessionOptions) {
    this.info = { id: '', name: options.title }
    const term = (this.terminal = new Terminal({
      fontSize: 13.5,
      lineHeight: 1.15,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      theme: terminalTheme,
      cursorBlink: true,
      scrollback: terminalService.scrollback,
      allowProposedApi: true,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: false,
      logLevel: 'off',
    }))
    this.own(() => term.dispose())
    try {
      const rendering = new TerminalRenderer(term, message => this.connection.fail(message), options.bufferChanged)
      this.own(() => rendering.dispose())
      term.loadAddon(new Unicode11Addon())
      term.unicode.activeVersion = '11'
      term.open(options.surface)
      this.own(attachTerminalLinks(term, url => options.blockedLink(url)))
      this.own(options.attachSearch(term, options.container))
      this.attachRenderer()
      term.textarea?.setAttribute('aria-label', 'Terminal input')
      term.textarea?.setAttribute('enterkeyhint', 'enter')
      this.own(attachTouchScroll(term))

      const size = () => this.geometry.size()
      const state = (next: TerminalState) => {
        if (this.disposed) return
        options.state(next)
        if (next.kind === 'connected' && !touchInput()) this.focus()
      }
      this.connection = new TerminalSocket(options.token, size, rendering, {
        state,
        hello: message => {
          this.setTitle(
            `${message.target.id}/${message.session.id}`,
            `${message.session.name} · ${message.target.name}`,
          )
          const tool = message.session.tool
          if (!this.disposed) options.toolChanged(tool)
        },
        activity: value => {
          if (!this.disposed) this.activity.update(value)
        },
        deliveries: waiting => {
          if (!this.disposed) options.deliveries(waiting)
        },
        signal: ({ signal }) => {
          if (signal.type === 'files.changed') {
            if (!this.disposed) options.filesChanged()
            return
          }
          if (signal.type !== 'browser.open') return
          let url: string
          try {
            url = browserUrl(signal.payload)
          } catch {
            return
          }
          void openBrowserTab(url).then(opened => {
            if (!this.disposed && !opened) options.blockedLink(url)
          })
        },
      })
      this.own(() => this.connection.close())
      this.geometry = new TerminalGeometry(term, options.surface, (cols, rows) => this.connection.resize(cols, rows))
      this.own(() => this.geometry.dispose())
      this.activity = new TerminalActivity(this.connection, message => this.notice(message, true))
      this.own(() => this.activity.dispose())
      this.bells = attachBell(
        term,
        options.bellChanged,
        () => this.info,
        message => this.notice(message, true),
      )
      this.own(() => this.bells.dispose())
      this.clipboard = attachClipboard(term, {
        connected: () => this.connection.connected,
        pasteImage: (file, mode) => void this.pasteImage(file, mode),
        status: this.notice,
        pasteFallback: options.showComposer,
      })
      this.own(() => this.clipboard.dispose())
      this.attachInput()
      this.attachActivity()
      const initial = size()
      term.resize(initial.cols, initial.rows)
      this.open()
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  get focused() {
    return document.visibilityState === 'visible' && document.hasFocus()
  }

  private notice = (message: string, sticky = false) => {
    if (!this.disposed) this.options.notice(message, sticky)
  }

  private setTitle(id: string, name: string) {
    if (this.disposed) return
    this.info = { id, name }
    this.options.titleChanged(name)
  }

  focus(force = false) {
    const active = document.activeElement
    if (
      !force &&
      active instanceof HTMLElement &&
      active !== this.terminal.textarea &&
      (active.closest('[role="menu"]') ||
        active.matches('button, a[href], input, textarea, select, [contenteditable="true"]'))
    )
      return
    if (!this.options.focusRecovery()) this.terminal.focus()
  }

  setModifiers(value: TerminalModifiers) {
    this.modifiers = value
    this.options.modifiersChanged(value)
  }

  press(key: string, extra?: TerminalModifiers) {
    const data = terminalKey(key, { ...this.modifiers, ...extra }, this.terminal.modes.applicationCursorKeysMode)
    if (data !== null) {
      this.connection.input(data)
      this.setModifiers({})
    }
  }

  submit(text: string) {
    const normalized = text.replace(/\r?\n/g, '\r')
    const data = this.terminal.modes.bracketedPasteMode ? `\x1b[200~${normalized}\x1b[201~` : normalized
    return this.connection.submit(data + '\r')
  }

  clearScreen() {
    if (this.disposed || !this.connection.connected || this.clearing) return
    this.clearing = true
    void this.connection
      .clear()
      .catch(error => this.notice((error as Error).message))
      .finally(() => {
        this.clearing = false
      })
  }

  private imageBusy = false

  async pasteImage(file: File, mode: ImagePasteMode = 'attachment') {
    if (this.disposed) return
    if (this.imageBusy) return this.notice('An image is already being attached. Please wait.', true)
    if (!this.connection.connected) return this.notice('Connect the terminal before attaching an image.')
    const problem = imageProblem(file)
    if (problem) return this.notice(problem)
    this.imageBusy = true
    this.notice('Uploading image…', true)
    try {
      await this.connection.pasteImage(file, mode)
      this.notice(mode === 'path' ? 'Image path pasted' : 'Image attached')
    } catch (error) {
      this.notice((error as Error).message)
    } finally {
      this.imageBusy = false
    }
  }

  private attachRenderer() {
    let renderer: WebglAddon | undefined
    try {
      renderer = new WebglAddon()
      renderer.onContextLoss(() => renderer?.dispose())
      this.terminal.loadAddon(renderer)
    } catch {
      renderer?.dispose()
      // xterm's DOM renderer remains available when GPU initialization fails.
    }
  }

  private attachInput() {
    const term = this.terminal
    const data = term.onData(value => {
      if ((this.modifiers.ctrl || this.modifiers.alt) && [...value].length === 1) {
        value = terminalKey(value, this.modifiers) ?? value
        this.setModifiers({})
      }
      this.connection.input(value)
    })
    const binary = term.onBinary(value =>
      this.connection.input(Uint8Array.from(value, character => character.charCodeAt(0))),
    )
    this.own(() => data.dispose())
    this.own(() => binary.dispose())
    const clearShortcut = clearScreenShortcut(/Mac|iPhone|iPad|iPod/.test(navigator.platform))
    term.attachCustomKeyEventHandler(event => {
      if (clearShortcut.matches(event)) {
        event.preventDefault()
        event.stopPropagation()
        if (event.type === 'keydown' && !event.repeat) this.clearScreen()
        return false
      }
      if (!this.clipboard.handleKey(event)) return false
      // Coding tools read Shift+Enter as a newline; xterm would send a plain Enter.
      if (
        event.type === 'keydown' &&
        event.key === 'Enter' &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey
      ) {
        event.preventDefault()
        this.connection.input('\x1b[13;2u')
        return false
      }
      return true
    })
  }

  private updateFocus = () => {
    this.activity.setActive(this.focused)
    this.connection.setActive(this.focused)
  }

  private acknowledgeActivity = () => {
    this.updateFocus()
    this.activity.acknowledge()
  }

  private attachActivity() {
    this.updateFocus()
    this.listen(window, 'focus', this.updateFocus)
    this.listen(window, 'blur', this.updateFocus)
    this.listen(document, 'visibilitychange', this.updateFocus)
    this.listen(window, 'click', this.acknowledgeActivity, true)
    this.listen(window, 'keydown', this.acknowledgeActivity, true)
    const resume = () => {
      if (document.visibilityState === 'visible') this.connection.resume()
    }
    this.listen(window, 'pageshow', resume)
    this.listen(window, 'focus', resume)
    this.listen(window, 'online', () => this.connection.networkChanged(true))
    this.listen(window, 'offline', () => this.connection.networkChanged(false))
    this.listen(document, 'visibilitychange', resume)
  }

  private open() {
    // Defer consuming a single-use token until after StrictMode's discarded mount.
    const start = setTimeout(() => this.connection.open(), 0)
    this.own(() => clearTimeout(start))
  }

  private own(cleanup: (() => void) | undefined) {
    if (cleanup) this.cleanups.push(cleanup)
  }

  private listen(target: EventTarget, name: string, callback: () => void, capture = false) {
    target.addEventListener(name, callback, capture)
    this.own(() => target.removeEventListener(name, callback, capture))
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    // Unsubscribe first, close the connection, then dispose rendering and xterm.
    // A cleanup failure must not leave other listeners active.
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try {
        cleanup()
      } catch (error) {
        console.error('Could not dispose a terminal resource', error)
      }
    }
  }
}
