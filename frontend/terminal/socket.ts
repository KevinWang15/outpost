import type { ClientMessage, ServerMessage } from '../../shared/protocol'
import { maxInputMessage, maxInputQueue, protocolVersion, terminalConnectionPolicy } from '../../shared/protocol'
import type { UploadedImage } from '../../shared/images'
import type { SessionActivity } from '../../shared/activity'
import type { TerminalRendering } from './rendering'
import type { TerminalConnection, TerminalState } from './connection'

interface Handlers {
  state(state: TerminalState): void
  hello(message: Extract<ServerMessage, { type: 'hello' }>): void
  signal(message: Extract<ServerMessage, { type: 'signal' }>): void
  activity(state: SessionActivity | null): void
}

/** The web client of the terminal protocol (shared/protocol.ts). Reconnects
 * with the resume token after drops; an ended session requires explicit reconnect. */
export class TerminalSocket implements TerminalConnection {
  private socket: WebSocket | null = null
  private token: string
  private attempts = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private started = false
  private allowStart = true
  private ready = false
  private readyAt = 0
  private receivedAt = 0
  private online = typeof navigator === 'undefined' || navigator.onLine !== false
  private requestedSize: { cols: number; rows: number } | null = null
  private active = false
  private heartbeat: ReturnType<typeof setTimeout> | undefined
  private probe: { id: string; deadline: number; timer: ReturnType<typeof setTimeout> } | null = null
  private cleanup: (() => void) | null = null
  private upload: AbortController | null = null
  private pending = new Map<
    string,
    { resolve: (message: Extract<ServerMessage, { type: 'result' }>) => void; reject: (error: Error) => void }
  >()

  constructor(
    token: string,
    private size: () => { cols: number; rows: number },
    private rendering: TerminalRendering,
    private handlers: Handlers,
  ) {
    this.token = token
  }

  get connected() {
    return this.ready && this.socket?.readyState === WebSocket.OPEN
  }

  open() {
    if (this.stopped) return
    this.started = true
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.detach()
    this.handlers.activity(null)
    const { cols, rows } = this.size()
    const url = new URL('/api/terminal', window.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.search = new URLSearchParams({
      token: this.token,
      cols: String(cols),
      rows: String(rows),
      protocol: String(protocolVersion),
      start: this.allowStart ? '1' : '0',
    }).toString()
    const socket = new WebSocket(url)
    // Only a user opening/reconnecting a terminal may start an exited tool.
    // A dropped connection may have missed the original exit notification.
    this.allowStart = false
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    this.receivedAt = Date.now()
    this.ready = false
    this.requestedSize = null
    this.rendering.begin()
    let acknowledged = 0
    let lastAck = 0
    let ackTimer: ReturnType<typeof setTimeout> | undefined
    const attachTimer = setTimeout(
      () =>
        this.lost(socket, { type: 'closed', reason: 'error', message: 'The terminal did not become ready in time.' }),
      terminalConnectionPolicy.clientAttachMs,
    )
    this.cleanup = () => {
      clearTimeout(ackTimer)
      clearTimeout(attachTimer)
    }
    const acknowledge = () => {
      clearTimeout(ackTimer)
      ackTimer = undefined
      if (this.socket === socket && socket.readyState === WebSocket.OPEN && acknowledged)
        this.send({ type: 'ack', bytes: acknowledged })
      acknowledged = 0
      lastAck = performance.now()
    }
    const rendered = (length: number) => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return
      acknowledged += length
      // A full history checkpoint contains thousands of parts. Batch its ACKs
      // with live output so restoring cannot trip the input message rate limit.
      if (acknowledged >= 64 * 1024 && performance.now() - lastAck >= 10) acknowledge()
      else ackTimer ??= setTimeout(acknowledge, 20)
    }
    socket.onmessage = event => {
      if (this.socket !== socket) return
      this.receivedAt = Date.now()
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data)
        this.rendering.output(bytes, () => rendered(bytes.length))
        return
      }
      let message: ServerMessage
      try {
        message = JSON.parse(event.data)
        if (!message || typeof message !== 'object' || typeof message.type !== 'string') throw new Error()
      } catch {
        this.fail('Outpost sent an invalid terminal message. Reload this terminal before reconnecting.')
        return
      }
      if (message.type === 'hello') {
        this.token = message.resume
        this.handlers.hello(message)
      } else if (message.type === 'restore' || message.type === 'geometry' || message.type === 'clear') {
        const length = new TextEncoder().encode(event.data).length
        this.rendering.restore(message, () => rendered(length))
      } else if (message.type === 'ready') {
        this.rendering.flush(() => {
          if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return
          if (this.ready) return this.fail('Outpost sent duplicate terminal readiness.')
          this.ready = true
          this.readyAt = Date.now()
          clearTimeout(attachTimer)
          this.scheduleProbe()
          this.handlers.state({ kind: 'connected' })
          const { cols, rows } = this.size()
          this.resize(cols, rows)
          this.send({ type: 'focus', active: this.active })
        })
      } else if (message.type === 'activity') {
        this.handlers.activity(message.activity)
      } else if (message.type === 'result') {
        if (message.id === this.probe?.id) {
          if (!message.ok) return this.unresponsive(socket)
          clearTimeout(this.probe.timer)
          this.probe = null
          if (Date.now() - this.readyAt >= terminalConnectionPolicy.stableMs) this.attempts = 0
          this.scheduleProbe()
          return
        }
        this.pending.get(message.id)?.resolve(message)
        this.pending.delete(message.id)
      } else if (message.type === 'signal') this.handlers.signal(message)
      else if (message.type === 'closed') this.lost(socket, message)
    }
    socket.onclose = event =>
      this.lost(socket, {
        type: 'closed',
        reason: event?.code === 1008 ? 'unavailable' : 'error',
        message:
          event?.code === 1008 ? event.reason || 'Terminal input was rejected.' : 'The connection to Outpost was lost.',
      })
    this.handlers.state(
      this.attempts
        ? { kind: 'reconnecting', attempt: this.attempts, message: 'Reconnecting…' }
        : { kind: 'connecting' },
    )
  }

  /** End one attempt exactly once, without waiting for a stuck close handshake.
   * Transient failures keep retrying; backoff, not a retry limit, bounds the load. */
  private lost(socket: WebSocket, message: Extract<ServerMessage, { type: 'closed' }>) {
    if (this.socket !== socket) return
    this.detach()
    this.handlers.activity(null)
    this.failPending('The connection closed before Outpost confirmed it. Check the terminal before retrying.')
    if (this.stopped) return
    if (message.reason !== 'error') {
      this.stopped = true
      this.handlers.state({ kind: 'closed', reason: message.reason, message: message.message })
      return
    }
    this.attempts++
    this.handlers.state({
      kind: 'reconnecting',
      attempt: this.attempts,
      message: this.online ? message.message : 'Waiting for a network connection…',
    })
    if (this.online) {
      // Spread recovery across tabs/clients when a server or network comes back.
      const delay = Math.min(terminalConnectionPolicy.retryMaxMs, 500 * 2 ** Math.min(this.attempts, 6))
      this.retryTimer = setTimeout(() => this.open(), delay * (0.5 + Math.random() / 2))
    }
  }

  private detach() {
    this.upload?.abort(
      new Error('The terminal disconnected before the image was pasted. Attach it again after reconnecting.'),
    )
    this.cleanup?.()
    this.cleanup = null
    clearTimeout(this.heartbeat)
    this.heartbeat = undefined
    if (this.probe) clearTimeout(this.probe.timer)
    this.probe = null
    const socket = this.socket
    this.socket = null
    this.ready = false
    if (socket) {
      socket.onmessage = null
      socket.onclose = null
      socket.close()
    }
  }

  /** Explicitly reconnect after an ended session or an unrecoverable connection error. */
  reconnect() {
    this.stopped = false
    this.allowStart = true
    this.attempts = 0
    clearTimeout(this.retryTimer)
    this.failPending('The terminal reconnected before Outpost confirmed it. Check the terminal before retrying.')
    this.open()
  }

  /** A suspended page may still think its old socket is open. Probe before replacing a healthy connection. */
  resume() {
    if (!this.started || this.stopped) return
    if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') this.online = navigator.onLine
    if (!this.socket) {
      this.open()
      return
    }
    const socket = this.socket
    if (!this.connected) {
      // Keep an attachment that is making progress. A handshake left behind by
      // sleep/network loss should not hold recovery hostage to the 75s deadline.
      const grace =
        socket.readyState === WebSocket.OPEN
          ? terminalConnectionPolicy.heartbeatMs
          : terminalConnectionPolicy.wakeProbeMs
      if (Date.now() - this.receivedAt >= grace) {
        this.unresponsive(socket)
        this.open()
      }
      return
    }
    this.check(terminalConnectionPolicy.wakeProbeMs)
  }

  networkChanged(online: boolean) {
    this.online = online
    if (online) this.resume()
    else {
      // OS connectivity is only a hint (a local server may still work). Keep
      // live/attaching sockets, but stop background retries until connectivity
      // returns or the user comes back to the terminal.
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
      if (this.started && !this.stopped && !this.socket)
        this.handlers.state({
          kind: 'reconnecting',
          attempt: this.attempts,
          message: 'Waiting for a network connection…',
        })
    }
  }

  private scheduleProbe() {
    clearTimeout(this.heartbeat)
    this.heartbeat = setTimeout(
      () => this.check(terminalConnectionPolicy.probeMs),
      terminalConnectionPolicy.heartbeatMs,
    )
  }

  private check(timeout: number) {
    const socket = this.socket
    if (!socket || !this.connected) return
    clearTimeout(this.heartbeat)
    this.heartbeat = undefined
    // Coalesce wake/visibility/online events. A wake can shorten an outstanding
    // periodic probe, but repeated events must never extend its deadline.
    const deadline = Math.min(this.probe?.deadline ?? Infinity, Date.now() + timeout)
    const id = this.probe?.id ?? crypto.randomUUID()
    const sending = !this.probe
    if (this.probe) clearTimeout(this.probe.timer)
    this.probe = {
      id,
      deadline,
      timer: setTimeout(() => this.unresponsive(socket), Math.max(0, deadline - Date.now())),
    }
    if (sending) this.send({ type: 'ping', id })
  }

  private unresponsive(socket: WebSocket) {
    this.lost(socket, { type: 'closed', reason: 'error', message: 'The remote terminal service stopped responding.' })
  }

  /** Keep a live connection and its draft; use the fresh grant for recovery. */
  async activate(token: string) {
    if (!this.connected) {
      this.token = token
      this.reconnect()
      return
    }
    const result = await this.request({ type: 'activate', id: crypto.randomUUID(), token })
    if (!result.ok) throw new Error(result.message)
  }

  fail(message: string) {
    this.close()
    this.handlers.state({ kind: 'closed', reason: 'error', message })
  }

  close() {
    this.stopped = true
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.handlers.activity(null)
    this.failPending('The terminal closed.')
    this.detach()
  }

  private send(message: ClientMessage) {
    const data = JSON.stringify(message)
    if (this.canSend(new TextEncoder().encode(data).length)) this.socket!.send(data)
  }

  private canSend(bytes: number) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false
    if (bytes + this.socket.bufferedAmount > maxInputQueue) {
      this.fail('Terminal input is backed up. Check the terminal before reconnecting; unsent input is not retried.')
      return false
    }
    return true
  }

  input(data: string | Uint8Array<ArrayBuffer>) {
    if (!this.connected) return false
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    if (bytes.length > 1024 * 1024) {
      this.fail('Terminal input is limited to 1 MiB at a time. Reconnect and paste smaller sections.')
      return false
    }
    if (!this.canSend(bytes.length)) return false
    for (let offset = 0; offset < bytes.length; offset += maxInputMessage)
      this.socket!.send(bytes.subarray(offset, offset + maxInputMessage))
    return true
  }

  resize(cols: number, rows: number) {
    if (!this.connected || (this.requestedSize?.cols === cols && this.requestedSize.rows === rows)) return
    // Track requests, not rendered geometry: the target's acknowledgement may
    // still be in flight when the user resizes back to an earlier dimension.
    this.requestedSize = { cols, rows }
    this.send({ type: 'resize', cols, rows })
  }

  setActive(active: boolean) {
    if (this.active === active) return
    this.active = active
    if (!this.connected) return
    // Store this viewer's latest size before claiming control of the PTY.
    const { cols, rows } = this.size()
    this.resize(cols, rows)
    this.send({ type: 'focus', active })
  }

  private request(message: ClientMessage & { id: string }, timeout = 60_000) {
    if (!this.connected) return Promise.reject(new Error('The terminal is not connected. Your draft is kept.'))
    return new Promise<Extract<ServerMessage, { type: 'result' }>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id)
        reject(new Error('Outpost did not confirm in time. Check the terminal before retrying.'))
      }, timeout)
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

  async clear() {
    const result = await this.request({ type: 'clear', id: crypto.randomUUID() })
    if (!result.ok) throw new Error(result.message)
  }

  /** Mark only the completion the user saw, using this terminal's authorization. */
  async acknowledge(completionId: string) {
    const result = await this.request({ type: 'acknowledge', id: crypto.randomUUID(), completionId })
    if (!result.ok) throw new Error(result.message)
  }

  /** Upload independently of interactive input, then paste into this attachment only. */
  async pasteImage(file: File) {
    if (!this.connected) throw new Error('Connect the terminal before attaching an image.')
    if (this.upload) throw new Error('Wait for the previous image to finish.')
    const socket = this.socket
    const controller = new AbortController()
    this.upload = controller
    const timeout = setTimeout(
      () => controller.abort(new Error('Image upload timed out. Try attaching it again.')),
      150_000,
    )
    try {
      const response = await fetch('/api/terminal/image', {
        method: 'POST',
        credentials: 'omit',
        headers: { authorization: `Bearer ${this.token}`, 'x-outpost-request': '1', 'content-type': file.type },
        body: file,
        signal: controller.signal,
      })
      if (!response.ok) {
        const error = await response.json().catch(() => null)
        throw new Error(error?.message || `Image upload failed (${response.status}).`)
      }
      const image: UploadedImage = await response.json()
      controller.signal.throwIfAborted()
      if (!this.connected || this.socket !== socket)
        throw new Error('The terminal changed before the image was pasted. Attach it again.')
      if (typeof image.reference !== 'string' || !image.reference)
        throw new Error('Outpost did not return an image reference.')
      // The service applies the running application's bracketed-paste mode.
      // A successful upload never submits the prompt or retries a paste.
      const result = await this.request({ type: 'paste', id: crypto.randomUUID(), data: image.reference })
      if (!result.ok) throw new Error(result.message)
      return image.reference
    } finally {
      clearTimeout(timeout)
      if (this.upload === controller) this.upload = null
    }
  }

  private failPending(message: string) {
    for (const entry of this.pending.values()) entry.reject(new Error(message))
    this.pending.clear()
  }
}
