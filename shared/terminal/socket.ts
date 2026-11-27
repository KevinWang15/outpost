import type { ImagePasteMode } from '../terminalFiles'
import type { Scrollback } from '../terminalService'
import { terminalFileChunk, type TerminalFileReader } from '../terminalFiles'
import { maxSessionFiles, parseSessionFile } from '../sessionFiles'
import type { ClientMessage, ServerMessage } from '../protocol'
import { maxInputMessage, maxInputQueue, protocolVersion, terminalConnectionPolicy } from '../protocol'
import { imageProblem } from '../images'
import type { SessionActivity } from '../activity'
import type { TerminalRendering } from './rendering'
import type { TerminalState } from './connection'

interface Handlers {
  state(state: TerminalState): void
  hello(message: Extract<ServerMessage, { type: 'hello' }>): void
  signal(message: Extract<ServerMessage, { type: 'signal' }>): void
  activity(state: SessionActivity | null): void
  /** Messages from other sessions waiting to be typed in. */
  deliveries(waiting: number): void
}

// Leading-edge coalescing intervals keep worst-case client frame rate
// (input <= 100/s, resize <= 40/s, ack <= 100/s) safely under the server's
// 300 messages/second cap while adding 0ms latency to normal interactive typing.
const INPUT_COALESCE_MS = 10
const RESIZE_COALESCE_MS = 25

function browserOnline(): boolean | undefined {
  const nav = (globalThis as { navigator?: { onLine?: unknown } }).navigator
  return typeof nav?.onLine === 'boolean' ? nav.onLine : undefined
}

function browserHref(): string {
  const root = globalThis as { window?: { location?: { href?: unknown } }; location?: { href?: unknown } }
  const href = root.window?.location?.href ?? root.location?.href
  if (typeof href === 'string') return href
  throw new Error('TerminalSocket requires an endpoint origin outside a browser.')
}

/** Client of the terminal protocol (shared/protocol.ts), shared by browser and desktop.
 * Reconnects with the resume token after drops; an ended session requires explicit reconnect. */
export class TerminalSocket {
  private scrollback?: Scrollback
  setScrollback(lines: Scrollback) {
    if (lines === this.scrollback) return
    this.scrollback = lines
    if (this.connected) this.send({ type: 'scrollback', lines })
  }

  private socket: WebSocket | null = null
  private token: string
  private attempts = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private waitingForSize = false
  private started = false
  private allowStart = true
  private ready = false
  // The service permits four outstanding reads. Keep one slot free and share
  // the remaining lanes across every reader on this attachment.
  private fileReads = Array.from({ length: 3 }, () => Promise.resolve())
  private readyAt = 0
  private receivedAt = 0
  private online = browserOnline() !== false
  private requestedSize: { cols: number; rows: number } | null = null
  private pendingResize: { cols: number; rows: number } | null = null
  private resizeTimer: ReturnType<typeof setTimeout> | undefined
  private lastResizeAt = 0
  private inputQueue: Uint8Array<ArrayBuffer>[] = []
  private inputQueueBytes = 0
  private inputTimer: ReturnType<typeof setTimeout> | undefined
  private lastInputAt = 0
  private active = false
  private drafting = false
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
    private size: () => { cols: number; rows: number } | undefined,
    private rendering: TerminalRendering,
    private handlers: Handlers,
    private endpoint?: { origin: string; open: (url: URL) => WebSocket },
  ) {
    this.token = token
  }

  get connected() {
    return this.ready && this.socket?.readyState === WebSocket.OPEN
  }

  open() {
    if (this.stopped) return
    this.started = true
    const size = this.size()
    this.waitingForSize = !size
    if (!size) return
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.detach()
    this.handlers.activity(null)
    const { cols, rows } = size
    const url = new URL('/api/terminal', this.endpoint?.origin ?? browserHref())
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.search = new URLSearchParams({
      token: this.token,
      ...(this.scrollback !== undefined && { scrollback: String(this.scrollback) }),
      cols: String(cols),
      rows: String(rows),
      protocol: String(protocolVersion),
      start: this.allowStart ? '1' : '0',
    }).toString()
    const socket = this.endpoint?.open(url) ?? new WebSocket(url)
    // Only a user opening/reconnecting a terminal may start an exited tool.
    // A dropped connection may have missed the original exit notification.
    this.allowStart = false
    socket.onerror = () => {} // onclose owns retries, including failed upgrades.
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    this.receivedAt = Date.now()
    this.ready = false
    this.requestedSize = null
    const requestedScrollback = this.scrollback
    this.rendering.begin(requestedScrollback)
    let acknowledged = 0
    let lastAck = 0
    let ackTimer: ReturnType<typeof setTimeout> | undefined
    let lastRestoreAt = Date.now()
    const checkAttach = () => {
      const remaining = lastRestoreAt + terminalConnectionPolicy.clientAttachMs - Date.now()
      if (remaining > 0) attachTimer = setTimeout(checkAttach, remaining)
      else this.lost(socket, { type: 'closed', reason: 'error', message: 'The terminal did not become ready in time.' })
    }
    let attachTimer = setTimeout(checkAttach, terminalConnectionPolicy.clientAttachMs)
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
        if (message.type === 'restore') lastRestoreAt = this.receivedAt
        this.rendering.restore(message, () => rendered(length))
      } else if (message.type === 'ready') {
        this.rendering.flush(() => {
          if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return
          if (this.ready) return this.fail('Outpost sent duplicate terminal readiness.')
          this.ready = true
          if (this.scrollback !== requestedScrollback && this.scrollback !== undefined)
            this.send({ type: 'scrollback', lines: this.scrollback })
          this.readyAt = Date.now()
          clearTimeout(attachTimer)
          this.scheduleProbe()
          this.handlers.state({ kind: 'connected' })
          const size = this.size()
          if (size) this.resize(size.cols, size.rows)
          this.send({ type: 'focus', active: this.active })
          if (this.drafting) this.send({ type: 'draft', active: true })
        })
      } else if (message.type === 'activity') {
        this.handlers.activity(message.activity)
      } else if (message.type === 'deliveries') {
        this.handlers.deliveries(message.waiting)
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
      new Error('The terminal disconnected before confirming image paste. Check the draft before retrying.'),
    )
    this.cleanup?.()
    this.cleanup = null
    clearTimeout(this.heartbeat)
    this.heartbeat = undefined
    clearTimeout(this.inputTimer)
    this.inputTimer = undefined
    this.inputQueue = []
    this.inputQueueBytes = 0
    this.lastInputAt = 0
    clearTimeout(this.resizeTimer)
    this.resizeTimer = undefined
    this.pendingResize = null
    this.lastResizeAt = 0
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
  reconnect(token = this.token) {
    this.token = token
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
    const online = browserOnline()
    if (online !== undefined) this.online = online
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
      this.reconnect(token)
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
    // Preserve FIFO order between buffered PTY input and ordered control commands
    // without letting background acks/pings break input burst coalescing.
    if (message.type !== 'ack' && message.type !== 'ping') this.flushInput()
    const data = JSON.stringify(message)
    const wire = this.socket
    if (wire && this.canSend(new TextEncoder().encode(data).length, wire)) wire.send(data)
  }

  private canSend(bytes: number, wire: WebSocket) {
    if (wire.readyState !== WebSocket.OPEN) return false
    if (bytes + wire.bufferedAmount > maxInputQueue) {
      this.fail('Terminal input is backed up. Check the terminal before reconnecting; unsent input is not retried.')
      return false
    }
    return true
  }

  private sendInputBytes(bytes: Uint8Array<ArrayBuffer>, wire: WebSocket) {
    for (let offset = 0; offset < bytes.length; offset += maxInputMessage)
      wire.send(bytes.subarray(offset, offset + maxInputMessage))
    this.lastInputAt = Date.now()
  }

  private flushInput() {
    clearTimeout(this.inputTimer)
    this.inputTimer = undefined
    if (this.inputQueue.length === 0) return
    const chunks = this.inputQueue
    const total = this.inputQueueBytes
    this.inputQueue = []
    this.inputQueueBytes = 0
    const wire = this.socket
    if (!this.connected || !wire || !this.canSend(total, wire)) return
    if (chunks.length === 1) {
      this.sendInputBytes(chunks[0], wire)
      return
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    this.sendInputBytes(merged, wire)
  }

  private flushResize() {
    clearTimeout(this.resizeTimer)
    this.resizeTimer = undefined
    const next = this.pendingResize
    this.pendingResize = null
    if (!next || !this.connected) return
    if (this.requestedSize?.cols === next.cols && this.requestedSize.rows === next.rows) return
    this.requestedSize = next
    this.lastResizeAt = Date.now()
    this.send({ type: 'resize', cols: next.cols, rows: next.rows })
  }

  input(data: string | Uint8Array<ArrayBuffer>) {
    if (!this.connected) return false
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    if (bytes.length === 0) return true
    if (bytes.length > 1024 * 1024) {
      this.fail('Terminal input is limited to 1 MiB at a time. Reconnect and paste smaller sections.')
      return false
    }
    const wire = this.socket
    if (!wire || !this.canSend(this.inputQueueBytes + bytes.length, wire)) return false
    const elapsed = Date.now() - this.lastInputAt
    if (this.inputQueue.length === 0 && elapsed >= INPUT_COALESCE_MS) {
      this.sendInputBytes(bytes, wire)
      return true
    }
    this.inputQueue.push(bytes)
    this.inputQueueBytes += bytes.length
    this.inputTimer ??= setTimeout(() => this.flushInput(), Math.max(1, INPUT_COALESCE_MS - elapsed))
    return true
  }

  resize(cols: number, rows: number) {
    if (this.waitingForSize) return this.open()
    if (!this.connected) return
    const latest = this.pendingResize ?? this.requestedSize
    if (latest?.cols === cols && latest.rows === rows) return
    const elapsed = Date.now() - this.lastResizeAt
    if (!this.resizeTimer && elapsed >= RESIZE_COALESCE_MS) {
      // Track requests, not rendered geometry: the target's acknowledgement may
      // still be in flight when the user resizes back to an earlier dimension.
      this.requestedSize = { cols, rows }
      this.lastResizeAt = Date.now()
      this.send({ type: 'resize', cols, rows })
      return
    }
    this.pendingResize = { cols, rows }
    this.resizeTimer ??= setTimeout(() => this.flushResize(), Math.max(1, RESIZE_COALESCE_MS - elapsed))
  }

  draft(active: boolean) {
    if (this.drafting === active) return
    this.drafting = active
    if (this.connected) this.send({ type: 'draft', active })
  }

  deliverNow() {
    if (this.connected) this.send({ type: 'deliver-now' })
  }

  setActive(active: boolean) {
    if (this.active === active) return
    this.active = active
    if (!this.connected) return
    // Store this viewer's latest size before claiming control of the PTY.
    const size = this.size()
    if (size) this.resize(size.cols, size.rows)
    this.flushResize()
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

  readonly listFiles = async (signal: AbortSignal) => {
    signal.throwIfAborted()
    const result = await this.request({ type: 'file-list', id: crypto.randomUUID() })
    signal.throwIfAborted()
    if (!result.ok) throw new Error(result.message || 'Could not list session files.')
    if (!Array.isArray(result.files) || result.files.length > maxSessionFiles)
      throw new Error('Invalid session file list.')
    return result.files.map(parseSessionFile)
  }
  readonly removeFile = async (file: string, signal: AbortSignal) => {
    signal.throwIfAborted()
    const result = await this.request({ type: 'file-remove', id: crypto.randomUUID(), file })
    if (!result.ok) throw new Error(result.message || 'Could not remove the session file.')
  }

  readonly readFile: TerminalFileReader = async (metadata, signal, progress) => {
    const file = parseSessionFile(metadata)
    if (!this.connected) throw new Error('Connect the terminal before downloading a file.')
    const attachment = this.socket
    const count = Math.max(1, Math.ceil(file.size / terminalFileChunk))
    const parts = new Array<Uint8Array<ArrayBuffer>>(count)
    let received = 0
    const readChunk = async (index: number) => {
      signal.throwIfAborted()
      if (!attachment || this.socket !== attachment) throw new Error('The terminal connection changed.')
      const offset = index * terminalFileChunk
      const result = await this.request({ type: 'file-read', id: crypto.randomUUID(), file: file.id, offset })
      signal.throwIfAborted()
      if (!result.ok) throw new Error(result.message || 'Could not read the session file.')
      const expected = Math.min(terminalFileChunk, file.size - offset)
      if (typeof result.chunk !== 'string' || result.chunk.length !== 4 * Math.ceil(expected / 3))
        throw new Error('The session sent an incomplete file.')
      const bytes = Uint8Array.from(atob(result.chunk), c => c.charCodeAt(0))
      if (bytes.length !== expected) throw new Error('The session sent an incomplete file.')
      parts[index] = bytes
      received += bytes.length
      progress?.(received)
    }
    for (let index = 0; index < count; index += this.fileReads.length) {
      const batch = this.fileReads.slice(0, count - index).map((previous, lane) => {
        const read = previous.then(() => readChunk(index + lane))
        this.fileReads[lane] = read.catch(() => {})
        return read
      })
      await Promise.all(batch)
    }
    return new Blob(parts, { type: file.mediaType })
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

  private async uploadOnSocket(file: File, signal: AbortSignal) {
    const problem = imageProblem(file)
    if (problem) throw new Error(problem)
    const transfer = crypto.randomUUID()
    const socket = this.socket
    for (let offset = 0; offset < file.size; offset += terminalFileChunk) {
      const bytes = new Uint8Array(await file.slice(offset, offset + terminalFileChunk).arrayBuffer())
      signal.throwIfAborted()
      if (!socket || this.socket !== socket) throw new Error('The terminal changed during image upload.')
      let binary = ''
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
      const reply = await this.request({
        type: 'image-write',
        id: crypto.randomUUID(),
        transfer,
        mime: file.type,
        size: file.size,
        offset,
        chunk: btoa(binary),
      })
      if (!reply.ok) throw new Error(reply.message || 'Image upload failed.')
    }
    return transfer
  }

  /** Upload independently of interactive input, then paste into this attachment only. */
  async pasteImage(file: File, mode: ImagePasteMode = 'attachment'): Promise<ImagePasteMode> {
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
      const transfer = await this.uploadOnSocket(file, controller.signal)
      controller.signal.throwIfAborted()
      if (!this.connected || this.socket !== socket)
        throw new Error('The terminal changed before the image was pasted. Attach it again.')
      const result = await this.request({ type: 'image-paste', id: crypto.randomUUID(), transfer, mode })
      if (!result.ok) throw new Error(result.message)
      return result.mode === 'attachment' || result.mode === 'path' ? result.mode : mode
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
