import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { parseSessionActivity, unavailableActivity } from '../activity'
import type { ClientMessage, CloseReason, ServerMessage } from '../protocol'
import { maxInputMessage, maxInputQueue, terminalConnectionPolicy } from '../protocol'
import { FrameDecoder, terminalControl, terminalFrame } from './terminalFrames'
import { signalValidators } from '../signals'
import { sessionFileId, maxSessionFiles } from '../sessionFiles'
import { terminalFileChunk, validImageWrite, validFileRead } from '../terminalFiles'
import { terminalSize } from '../terminalService'
import { terminalFailure } from '../../backend/terminal/failures'
import type { Stream } from '../../backend/machines'

const highWater = 256 * 1024
export const closedMessages: Record<'ended' | 'expired', string> = {
  ended: 'The coding tool exited. Connect again to start it in the same conversation.',
  expired: 'This connection expired. Click Connect in Outpost to open a new terminal.',
}

interface ViewerHost<Identity> {
  renew?(ticket: string): void
  logged(connection: Connection<Identity>, change: 'opened' | 'closed'): void
  activate(grant: Identity, token: string): boolean
  filesChanged(grant: Identity): void
  forget(connection: Connection<Identity>): void
}
/** One client socket attached to one terminal stream on the machine connection.
 * Closing either end ends both; the machine's terminal service keeps the session. */
export class Connection<Identity> {
  private routeChoice?: { slot: string; finish: (direct: boolean) => void }
  private controlOnly = false
  private stream: Stream | null = null
  private decoder = new FrameDecoder()
  private started = false
  /** Output waits for the viewer to acknowledge what it has. */
  private paused = false
  private pending: Buffer[] = []
  private pendingBytes = 0
  private unacked = 0
  private lastOutputProgress = 0
  private finished = false
  private transfers = new Map<string, string>()
  private signals = { count: 0, until: 0 }
  private window = { messages: 0, bytes: 0, until: 0 }
  private heartbeat: NodeJS.Timeout
  private attachTimer: NodeJS.Timeout
  private probe: { id: string; sentAt: number } | null = null
  private alive = true
  readonly abort = new AbortController()
  /** Its session and machine, once known, and why it closed. */
  named: { machine: { id: string; name: string }; session: { id: string; name: string } } | null = null
  closing: { reason: CloseReason; message: string } | null = null

  constructor(
    readonly grant: Identity,
    private socket: WebSocket,
    private broker: ViewerHost<Identity>,
  ) {
    socket.on('message', (data, binary) => this.receive(data as Buffer, binary))
    socket.on('close', () => this.finish())
    socket.on('error', () => socket.terminate())
    socket.on('pong', () => {
      this.alive = true
    })
    this.heartbeat = setInterval(() => {
      if (!this.alive) return socket.terminate()
      this.alive = false
      socket.ping()
      this.checkTarget()
    }, terminalConnectionPolicy.heartbeatMs).unref()
    this.attachTimer = setTimeout(
      () => this.close('error', 'The terminal did not become ready in time.'),
      terminalConnectionPolicy.attachMs,
    ).unref()
  }

  private checkTarget() {
    if (this.controlOnly || !this.started || this.finished) return
    const now = Date.now()
    // The response shares stdout with output. A viewer deliberately applying
    // backpressure must drain before we can judge the target's responsiveness.
    if (this.paused) {
      if (now - this.lastOutputProgress >= terminalConnectionPolicy.outputStallMs)
        return this.close('error', 'The terminal viewer stopped processing output.')
      if (this.probe) this.probe.sentAt = now
      return
    }
    if (this.probe) {
      if (now - this.probe.sentAt >= terminalConnectionPolicy.probeMs)
        this.close('error', 'The remote terminal service stopped responding.')
      return
    }
    this.probe = { id: randomUUID(), sentAt: now }
    this.toService({ type: 'ping', id: this.probe.id })
  }

  private pauseOutput() {
    if (!this.paused) this.lastOutputProgress = Date.now()
    this.paused = true
    this.stream?.pause()
  }

  send(message: ServerMessage) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  chooseRoute(offer: Extract<ServerMessage, { type: 'route-offer' }>) {
    return new Promise<boolean>(resolve => {
      const finish = (direct: boolean) => {
        clearTimeout(timer)
        this.routeChoice = undefined
        resolve(direct)
      }
      const timer = setTimeout(() => finish(false), 2500).unref()
      this.routeChoice = { slot: offer.slot, finish }
      this.send(offer)
    })
  }

  authorizeDirect() {
    this.controlOnly = true
    this.started = true
    clearTimeout(this.attachTimer)
  }

  start(stream: Stream) {
    if (this.finished) return stream.end()
    this.stream = stream
    if ((stream.opened as { route?: string } | null)?.route === 'direct') {
      this.controlOnly = true
      this.started = true
      clearTimeout(this.attachTimer)
      this.send({ type: 'route-selected', route: 'direct' })
      this.broker.logged(this, 'opened')
      stream.onClose(error => this.close('error', error?.message ?? 'The direct attachment ended.'))
      return
    }
    stream.onData(chunk => this.output(chunk))
    stream.onClose(error => {
      if (this.finished) return
      if (error && !this.started) {
        const failure = terminalFailure(error)
        return this.close(failure.reason, failure.message)
      }
      this.close('error', error?.message ?? 'The connection to the machine was lost.')
    })
  }

  private output(chunk: Buffer) {
    if (this.finished) return
    let frames
    try {
      frames = this.decoder.feed(chunk)
    } catch {
      return this.close('unavailable', 'The machine sent an invalid terminal stream.')
    }
    for (const { kind, payload } of frames) {
      if (this.finished) return
      if (kind === 'O') {
        if (this.socket.readyState !== WebSocket.OPEN) continue
        this.unacked += payload.length
        this.socket.send(payload)
        if (this.unacked > highWater) this.pauseOutput()
      } else if (kind === 'C') {
        let message
        try {
          message = JSON.parse(payload.toString('utf8'))
        } catch {
          return this.close('unavailable', 'The machine sent an invalid control message.')
        }
        if (!message || typeof message !== 'object' || Array.isArray(message))
          return this.close('unavailable', 'The machine sent an invalid control message.')
        this.control(message)
      }
    }
  }

  private control(message: { type?: string; [key: string]: unknown }) {
    if (message.type === 'restore' || message.type === 'geometry' || message.type === 'clear') {
      const data = JSON.stringify(message)
      this.unacked += Buffer.byteLength(data)
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(data)
      if (this.unacked > highWater) this.pauseOutput()
    } else if (message.type === 'error') {
      this.close(
        message.retryable === true ? 'error' : 'unavailable',
        typeof message.message === 'string' ? message.message : 'Terminal service failed.',
      )
    } else if (message.type === 'ready') {
      if (this.started) return this.close('unavailable', 'The machine sent duplicate terminal readiness.')
      this.started = true
      clearTimeout(this.attachTimer)
      const pending = this.pending
      this.pending = []
      this.pendingBytes = 0
      for (const frame of pending) this.write(frame)
      this.send({ type: 'ready' })
      this.broker.logged(this, 'opened')
      this.checkTarget()
    } else if (message.type === 'deliveries') {
      if (Number.isSafeInteger(message.waiting) && (message.waiting as number) >= 0)
        this.send({ type: 'deliveries', waiting: message.waiting as number })
    } else if (message.type === 'files') {
      // The agent stored a file: every viewer of the session refreshes its list.
      this.broker.filesChanged(this.grant)
    } else if (message.type === 'activity') {
      this.send({
        type: 'activity',
        activity:
          parseSessionActivity(message.activity) ?? unavailableActivity('The machine sent invalid activity metadata.'),
      })
    } else if (message.type === 'result' && typeof message.id === 'string') {
      if (message.id === this.probe?.id) {
        if (message.ok === true) this.probe = null
        else this.close('error', 'The remote terminal service failed its health check.')
        return
      }
      const transfer = this.transfers.get(message.id)
      this.transfers.delete(message.id)
      if (transfer && this.socket.bufferedAmount > 2 * 1024 * 1024)
        return this.close('error', 'The file viewer stopped receiving data.')
      this.send({
        type: 'result',
        id: message.id,
        ok: message.ok === true,
        ...(typeof message.message === 'string' ? { message: message.message } : {}),
        ...(transfer === 'image-write' &&
          typeof message.reference === 'string' &&
          message.reference.length < 8192 && { reference: message.reference }),
        ...(transfer === 'file-list' &&
          Array.isArray(message.files) &&
          message.files.length <= maxSessionFiles && { files: message.files }),
        ...(transfer === 'file-read' &&
        typeof message.chunk === 'string' &&
        message.chunk.length <= 4 * Math.ceil(terminalFileChunk / 3)
          ? { chunk: message.chunk }
          : {}),
      })
    } else if (message.type === 'signal' && typeof message.id === 'string') {
      const reply = (ok: boolean, text?: string) =>
        this.toService({ type: 'signal-result', id: message.id, ok, ...(text ? { message: text } : {}) })
      const signal = message.signal as { type?: unknown; payload?: unknown } | undefined
      const validate =
        typeof signal?.type === 'string' && Object.hasOwn(signalValidators, signal.type)
          ? signalValidators[signal.type]
          : undefined
      if (!validate) return reply(false, 'Outpost does not handle this signal type.')
      const now = Date.now()
      if (this.signals.until <= now) this.signals = { count: 0, until: now + 60_000 }
      if (++this.signals.count > 120) return reply(false, 'Too many signals from this session. Try again in a minute.')
      let payload
      try {
        payload = validate(signal!.payload)
      } catch (error) {
        return reply(false, (error as Error).message)
      }
      if (this.socket.readyState !== WebSocket.OPEN) return reply(false, 'The terminal client disconnected.')
      this.send({ type: 'signal', signal: { type: signal!.type as string, payload } })
      reply(true)
    } else if (message.type === 'exit' && message.reason === 'ended') {
      // The terminal service owns the coding process: its exit ends the session
      // at once, without waiting for the stream to close.
      this.close('ended', closedMessages.ended)
    }
  }

  /** A control message for the terminal service. */
  private toService(message: object) {
    this.write(terminalControl(message))
  }

  private write(frame: Buffer) {
    if (this.finished) return
    if (this.started && this.stream) {
      this.stream.write(frame)
      return
    }
    // Signal replies can precede restoration readiness. Keep their order with
    // early input, but bound both bytes and object count until the terminal is ready.
    if (this.pendingBytes + frame.length > maxInputMessage || this.pending.length >= 256)
      return this.close('unavailable', 'Too much input arrived before the terminal was ready.')
    this.pending.push(frame)
    this.pendingBytes += frame.length
  }

  private receive(data: Buffer, binary: boolean) {
    if (this.finished) return
    const now = Date.now()
    if (this.window.until <= now) this.window = { messages: 0, bytes: 0, until: now + 1000 }
    if (++this.window.messages > 300) return this.socket.close(1008, 'Message rate exceeded')
    if (binary) {
      if (this.controlOnly) return this.socket.close(1008, 'Session traffic belongs on the direct attachment')
      if (data.length > maxInputMessage || (this.window.bytes += data.length) > 1024 * 1024)
        return this.socket.close(1008, 'Input rate exceeded')
      return this.write(terminalFrame('I', data))
    }
    if (data.length > maxInputQueue) return this.socket.close(1008, 'Terminal message is too large')
    let message: ClientMessage
    try {
      message = JSON.parse(data.toString('utf8'))
    } catch {
      return this.socket.close(1008, 'Invalid terminal message')
    }
    if (!message || typeof message !== 'object' || Array.isArray(message))
      return this.socket.close(1008, 'Invalid terminal message')
    const id = (message as { id?: unknown }).id
    if (id !== undefined && (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)))
      return this.socket.close(1008, 'Invalid terminal message')
    if (['ping', 'send', 'paste', 'activate', 'acknowledge', 'clear'].includes(message.type) && id === undefined)
      return this.socket.close(1008, 'A terminal request ID is required')
    if (message.type === 'direct-lease' && this.broker.renew) {
      this.broker.renew(message.ticket)
      return
    }
    if (message.type === 'route-choice') {
      if (this.routeChoice?.slot === message.slot && typeof message.direct === 'boolean')
        this.routeChoice?.finish(message.direct)
      return
    }
    if (this.controlOnly && message.type !== 'activate')
      return this.socket.close(1008, 'Invalid attachment control message')
    switch (message.type) {
      case 'file-list':
      case 'file-remove':
      case 'image-write':
      case 'file-read': {
        if (
          !id ||
          (message.type === 'file-read' && !validFileRead(message)) ||
          (message.type === 'image-write' && !validImageWrite(message)) ||
          (message.type === 'file-remove' && !sessionFileId(message.file))
        )
          return this.socket.close(1008, 'Invalid attachment request')
        if (!this.started || !this.stream)
          return this.send({ type: 'result', id: message.id, ok: false, message: 'The terminal is not ready.' })
        if (this.transfers.has(message.id)) return this.socket.close(1008, 'Duplicate attachment request ID')
        if (this.transfers.size >= 8)
          return this.send({
            type: 'result',
            id: message.id,
            ok: false,
            message: 'Too many concurrent attachment requests.',
          })
        this.transfers.set(message.id, message.type)
        return this.toService(message)
      }
      case 'ping':
        return this.toService(message)
      case 'clear':
        if (!this.started || !this.stream)
          return this.send({ type: 'result', id: message.id, ok: false, message: 'The terminal is not ready.' })
        this.toService(message)
        return
      case 'acknowledge':
        if (typeof message.completionId !== 'string' || !/^[a-f0-9]{64}$/.test(message.completionId))
          return this.socket.close(1008, 'Invalid activity acknowledgement')
        this.toService(message)
        return
      case 'activate': {
        const ok =
          this.started &&
          typeof message.token === 'string' &&
          message.token.length <= 8192 &&
          this.broker.activate(this.grant, message.token)
        return this.send({
          type: 'result',
          id: message.id,
          ok,
          ...(!ok && { message: 'Could not accept this launch ticket. Use Connect in Outpost again.' }),
        })
      }
      case 'resize':
        if (terminalSize(message.cols, message.rows)) {
          this.toService({ type: 'resize', cols: message.cols, rows: message.rows })
        }
        return
      case 'focus':
        if (typeof message.active === 'boolean') this.toService({ type: 'focus', active: message.active })
        return
      case 'draft':
        if (typeof message.active === 'boolean') this.toService({ type: 'draft', active: message.active })
        return
      case 'deliver-now':
        return this.toService({ type: 'deliver-now' })
      case 'ack':
        if (Number.isSafeInteger(message.bytes) && message.bytes >= 0 && message.bytes <= this.unacked) {
          if (message.bytes) this.lastOutputProgress = Date.now()
          this.unacked = Math.max(0, this.unacked - message.bytes)
          if (this.unacked <= highWater / 2 && this.paused) {
            if (this.probe) this.probe.sentAt = Date.now()
            this.paused = false
            this.stream?.resume()
          }
        }
        return
      case 'paste':
      case 'send': {
        if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > maxInputMessage)
          return this.send({
            type: 'result',
            id: message.id,
            ok: false,
            message: 'Input must fit within 64 KiB. Send smaller sections.',
          })
        if ((this.window.bytes += Buffer.byteLength(message.data)) > 1024 * 1024)
          return this.socket.close(1008, 'Input rate exceeded')
        if (!this.started || !this.stream)
          return this.send({
            type: 'result',
            id: message.id,
            ok: false,
            message: 'The terminal is not ready. Your draft is kept.',
          })
        this.toService(message)
        return
      }
      default:
        return this.socket.close(1008, 'Invalid terminal message')
    }
  }

  close(reason: CloseReason, message: string) {
    if (this.finished) return
    this.closing = { reason, message }
    this.send({ type: 'closed', reason, message })
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, reason)
    this.finish()
  }

  private finish() {
    if (this.finished) return
    this.finished = true
    this.routeChoice?.finish(false)
    clearInterval(this.heartbeat)
    clearTimeout(this.attachTimer)
    this.abort.abort()
    this.pending = []
    this.pendingBytes = 0
    this.broker.forget(this)
    this.stream?.end()
    if (this.started) this.broker.logged(this, 'closed')
  }
}
