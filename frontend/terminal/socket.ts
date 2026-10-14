import type { ClientMessage, CloseReason, ScrollbackState, ServerMessage } from '../../shared/protocol'
import { protocolVersion } from '../../shared/protocol'
import type { ImageMediaType } from '../../shared/model'

export type SocketState =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting'; attempt: number; message: string }
  | { kind: 'closed'; reason: CloseReason; message: string }

interface Handlers {
  output(bytes: Uint8Array, rendered: () => void): void
  state(state: SocketState): void
  hello(message: Extract<ServerMessage, { type: 'hello' }>): void
  signal(message: Extract<ServerMessage, { type: 'signal' }>): void
  scrollback?(state: ScrollbackState | null): void
}

const retries = 8

/** The web client of the terminal protocol (shared/protocol.ts). Reconnects
 * with the resume token after drops; detaching or the session ending is final. */
export class TerminalSocket {
  private socket: WebSocket | null = null
  private token: string
  private attempts = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private ready = false
  private historySupported = false
  private historyTimer: ReturnType<typeof setTimeout> | undefined
  private historyOffset: number | undefined
  private pending = new Map<
    string,
    { resolve: (message: Extract<ServerMessage, { type: 'result' }>) => void; reject: (error: Error) => void }
  >()

  constructor(
    token: string,
    private size: () => { cols: number; rows: number },
    private handlers: Handlers,
  ) {
    this.token = token
  }

  get connected() {
    return this.ready && this.socket?.readyState === WebSocket.OPEN
  }

  open() {
    if (this.stopped) return
    this.resetHistory()
    const { cols, rows } = this.size()
    const url = new URL('/api/terminal', window.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.search = new URLSearchParams({
      token: this.token,
      cols: String(cols),
      rows: String(rows),
      client: 'web',
      protocol: String(protocolVersion),
    }).toString()
    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    this.ready = false
    let closed: Extract<ServerMessage, { type: 'closed' }> | null = null
    socket.onmessage = event => {
      if (this.socket !== socket) return
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data)
        this.handlers.output(bytes, () => this.send({ type: 'ack', bytes: bytes.length }))
        return
      }
      const message: ServerMessage = JSON.parse(event.data)
      if (message.type === 'hello') {
        this.token = message.resume
        this.handlers.hello(message)
      } else if (message.type === 'ready') {
        this.ready = true
        this.attempts = 0
        this.handlers.state({ kind: 'connected' })
        this.send({ type: 'resize', ...this.size() })
        this.historySupported = message.scrollback === true
        if (this.historySupported && this.handlers.scrollback) this.send({ type: 'scrollback' })
      } else if (message.type === 'scrollback') {
        this.handlers.scrollback?.(message)
      } else if (message.type === 'result') {
        this.pending.get(message.id)?.resolve(message)
        this.pending.delete(message.id)
      } else if (message.type === 'signal') this.handlers.signal(message)
      else if (message.type === 'closed') closed = message
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.ready = false
      this.resetHistory()
      this.failPending('The connection closed before Outpost confirmed it. Check the terminal before retrying.')
      if (this.stopped) return
      const message = closed as Extract<ServerMessage, { type: 'closed' }> | null
      if (message && message.reason !== 'error')
        return this.handlers.state({ kind: 'closed', reason: message.reason, message: message.message })
      if (++this.attempts > retries)
        return this.handlers.state({
          kind: 'closed',
          reason: 'error',
          message: message?.message ?? 'The connection to Outpost was lost.',
        })
      this.handlers.state({
        kind: 'reconnecting',
        attempt: this.attempts,
        message: message?.message ?? 'Connection lost.',
      })
      this.timer = setTimeout(() => this.open(), Math.min(10_000, 500 * 2 ** this.attempts))
    }
    this.handlers.state(
      this.attempts
        ? { kind: 'reconnecting', attempt: this.attempts, message: 'Reconnecting…' }
        : { kind: 'connecting' },
    )
  }

  /** Try again after a final close (e.g. detached): the resume token still works. */
  reconnect() {
    this.stopped = false
    this.attempts = 0
    clearTimeout(this.timer)
    this.socket?.close()
    this.open()
  }

  close() {
    this.stopped = true
    clearTimeout(this.timer)
    this.resetHistory()
    this.failPending('The terminal closed.')
    this.socket?.close()
    this.socket = null
  }

  private send(message: ClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  input(data: string | Uint8Array<ArrayBuffer>) {
    if (!this.connected) return false
    this.socket!.send(typeof data === 'string' ? new TextEncoder().encode(data) : data)
    return true
  }

  resize(cols: number, rows: number) {
    if (this.connected) this.send({ type: 'resize', cols, rows })
  }

  scrollTo(offset: number) {
    if (!this.connected || !this.historySupported) return
    this.historyOffset = Math.max(-1, Math.min(1_000_000, Math.round(offset)))
    const flush = () => {
      this.historyTimer = undefined
      if (this.historyOffset !== undefined && this.connected)
        this.send({ type: 'scrollback', offset: this.historyOffset })
      this.historyOffset = undefined
    }
    // Jump endpoints immediately. Keep only the latest position during a drag.
    if (offset <= 0) {
      clearTimeout(this.historyTimer)
      flush()
    } else this.historyTimer ??= setTimeout(flush, 50)
  }

  private resetHistory() {
    clearTimeout(this.historyTimer)
    this.historyTimer = undefined
    this.historyOffset = undefined
    this.historySupported = false
    this.handlers.scrollback?.(null)
  }

  private request(message: ClientMessage & { id: string }) {
    if (!this.connected) return Promise.reject(new Error('The terminal is not connected. Your draft is kept.'))
    return new Promise<Extract<ServerMessage, { type: 'result' }>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id)
        reject(new Error('Outpost did not confirm in time. Check the terminal before retrying.'))
      }, 60_000)
      this.pending.set(message.id, {
        resolve: result => {
          clearTimeout(timer)
          resolve(result)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.send(message)
    })
  }

  /** Send a draft and wait until it reached the target. */
  async submit(data: string) {
    const result = await this.request({ type: 'send', id: crypto.randomUUID(), data })
    if (!result.ok) throw new Error(result.message)
  }

  /** Upload an image over this connection; the target pastes its path once. */
  async pasteImage(data: string, mediaType: ImageMediaType) {
    const result = await this.request({ type: 'paste-image', id: crypto.randomUUID(), data, mediaType })
    if (!result.ok) throw new Error(result.message)
    return result.reference!
  }

  private failPending(message: string) {
    for (const entry of this.pending.values()) entry.reject(new Error(message))
    this.pending.clear()
  }
}
