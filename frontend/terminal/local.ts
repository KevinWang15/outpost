import type { LocalTerminalBridge, LocalTerminalEvent } from '../../shared/localTerminal'
import type { ImageMediaType } from '../../shared/model'
import type { TerminalConnection, TerminalState } from './connection'
import type { TerminalRendering } from './rendering'

/** A tab's local PTY, with ordered geometry and rendering acknowledgements. */
export class LocalTerminalConnection implements TerminalConnection {
  connected = false
  private generation = ''
  private stopEvents?: () => void
  private requestedSize?: { cols: number; rows: number }

  constructor(
    private bridge: LocalTerminalBridge,
    private size: () => { cols: number; rows: number },
    private rendering: TerminalRendering,
    private state: (state: TerminalState) => void,
    private title: (name: string) => void,
    private notice: (message: string) => void,
  ) {}

  open() {
    this.close()
    const generation = (this.generation = crypto.randomUUID())
    this.rendering.begin()
    this.state({ kind: 'connecting' })
    this.stopEvents = this.bridge.onEvent(event => {
      if (event.generation === this.generation) this.event(event)
    })
    const { cols, rows } = this.size()
    this.requestedSize = { cols, rows }
    this.perform(this.bridge.start(generation, cols, rows))
  }

  private event(event: LocalTerminalEvent) {
    if (event.type === 'ready' || event.type === 'geometry') {
      this.rendering.restore({ type: 'geometry', cols: event.cols, rows: event.rows }, () => {
        if (event.type === 'ready') {
          this.connected = true
          this.title(event.name)
          this.state({ kind: 'connected' })
          const size = this.size()
          this.resize(size.cols, size.rows)
        }
      })
    } else if (event.type === 'data') {
      this.rendering.output(new TextEncoder().encode(event.data), () => {
        this.bridge.acknowledge(event.generation, event.data.length)
      })
    } else {
      this.rendering.flush(() => {
        this.connected = false
        this.state({ kind: 'closed', reason: 'ended', message: `Shell exited with code ${event.code}.` })
      })
    }
  }

  private perform(work: Promise<unknown>, fatal = true) {
    const generation = this.generation
    void work.catch(error => {
      if (this.generation !== generation) return
      if (fatal) this.fail((error as Error).message)
      else this.notice((error as Error).message)
    })
  }

  reconnect() {
    // A live local shell must never be killed by the remote reconnect menu.
    if (!this.connected) this.open()
  }

  close() {
    const generation = this.generation
    this.generation = ''
    this.connected = false
    this.stopEvents?.()
    this.stopEvents = undefined
    if (generation) void this.bridge.stop(generation).catch(() => {})
  }

  fail(message: string) {
    this.close()
    this.state({ kind: 'closed', reason: 'error', message })
  }

  input(data: string | Uint8Array<ArrayBuffer>) {
    if (!this.connected) return false
    this.perform(this.bridge.write(this.generation, data), false)
    return true
  }

  resize(cols: number, rows: number) {
    if (!this.connected || (this.requestedSize?.cols === cols && this.requestedSize.rows === rows)) return
    this.requestedSize = { cols, rows }
    this.perform(this.bridge.resize(this.generation, cols, rows))
  }

  async submit(data: string) {
    if (!this.connected) throw new Error('The shell is not running. Your draft is kept.')
    await this.bridge.write(this.generation, data)
  }

  async pasteImage(data: string, mediaType: ImageMediaType) {
    if (!this.connected) throw new Error('The shell is not running.')
    return this.bridge.pasteImage(this.generation, data, mediaType)
  }
}
