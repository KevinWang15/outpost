import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { parseSessionActivity, unavailableActivity } from '../../shared/activity'
import type { ClientMessage, CloseReason, ServerMessage } from '../../shared/protocol'
import { maxInputMessage, maxInputQueue, protocolVersion, terminalConnectionPolicy } from '../../shared/protocol'
import { FrameDecoder, terminalControl, terminalFrame } from '../../shared/node/terminalFrames'
import { signalValidators } from '../../shared/signals'
import { terminalService, terminalSize } from '../../shared/terminalService'
import type { Owner } from '../deployment'
import { terminalFailure } from './failures'
import type { Stream } from '../machines'
import type { SessionService, TargetContext } from '../sessions'
import type { ConnectTokens, Grant } from './tokens'

const highWater = 256 * 1024
const closedMessages: Record<'ended' | 'expired', string> = {
  ended: 'The coding tool exited. Connect again to start it in the same conversation.',
  expired: 'This connection expired. Click Connect in Outpost to open a new terminal.',
}

export interface TerminalQuery {
  token?: string
  cols?: string
  rows?: string
  protocol?: string
  start?: string
}

interface Dependencies {
  tokens: ConnectTokens
  active(owner: Owner): boolean
  sessions: SessionService
  resolve(owner: Owner, targetId: string): Promise<TargetContext>
}

/** One client socket attached to one terminal stream on the machine connection.
 * Closing either end ends both; the machine's terminal service keeps the session. */
class Connection {
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
  private signals = { count: 0, until: 0 }
  private window = { messages: 0, bytes: 0, until: 0 }
  private heartbeat: NodeJS.Timeout
  private attachTimer: NodeJS.Timeout
  private probe: { id: string; sentAt: number } | null = null
  private alive = true
  readonly abort = new AbortController()

  constructor(
    readonly grant: Grant,
    private socket: WebSocket,
    private broker: TerminalBroker,
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
    if (!this.started || this.finished) return
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

  start(stream: Stream) {
    if (this.finished) return stream.end()
    this.stream = stream
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
      this.send({
        type: 'result',
        id: message.id,
        ok: message.ok === true,
        ...(typeof message.message === 'string' ? { message: message.message } : {}),
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
      if (this.socket.readyState !== WebSocket.OPEN) return reply(false, 'The Outpost terminal disconnected.')
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
    switch (message.type) {
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
    this.send({ type: 'closed', reason, message })
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, reason)
    this.finish()
  }

  private finish() {
    if (this.finished) return
    this.finished = true
    clearInterval(this.heartbeat)
    clearTimeout(this.attachTimer)
    this.abort.abort()
    this.pending = []
    this.pendingBytes = 0
    this.broker.forget(this)
    this.stream?.end()
  }
}

export class TerminalBroker {
  private connections = new Set<Connection>()
  private sweep: NodeJS.Timeout
  private stopped = false
  constructor(private dependencies: Dependencies) {
    this.sweep = setInterval(() => {
      for (const connection of this.connections) {
        if (!dependencies.active(connection.grant.owner))
          connection.close('expired', 'Sign-in ended. Sign in and connect again.')
      }
    }, 5000).unref()
  }
  forget(connection: Connection) {
    this.connections.delete(connection)
  }

  /** A fresh Connect can focus an existing tab without attaching another PTY. */
  activate(grant: Grant, token: string) {
    if (this.stopped || !this.dependencies.active(grant.owner)) return false
    const redeemed = this.dependencies.tokens.redeem(token, grant)
    if (!redeemed) return false
    return true
  }

  async accept(socket: WebSocket, query: TerminalQuery) {
    const reject = (reason: CloseReason, message: string) => {
      socket.send(JSON.stringify({ type: 'closed', reason, message } satisfies ServerMessage))
      socket.close(1000, reason)
    }
    // Checked before the token is redeemed, so the same link works after updating.
    if (query.protocol !== String(protocolVersion)) {
      return reject('outdated', 'Outpost was updated. Reload this terminal to reconnect.')
    }
    const redeemed = this.stopped ? null : this.dependencies.tokens.redeem(query.token ?? '')
    if (!redeemed || !this.dependencies.active(redeemed.grant.owner)) return reject('expired', closedMessages.expired)
    const { grant } = redeemed
    if ([...this.connections].filter(connection => connection.grant.owner.userId === grant.owner.userId).length >= 16) {
      // After a network change, old viewers may occupy slots until their
      // heartbeat expires. An established session must be able to retry then.
      return reject(
        redeemed.kind === 'resume' ? 'error' : 'unavailable',
        'Too many open terminals. Close one and try again.',
      )
    }
    const cols = Number(query.cols ?? 80),
      rows = Number(query.rows ?? 24)
    const connection = new Connection(grant, socket, this)
    this.connections.add(connection)
    try {
      const context = await this.dependencies.resolve(grant.owner, grant.targetId)
      if (connection.abort.signal.aborted) return
      const session = await this.dependencies.sessions.get(context, grant.sessionId, connection.abort.signal)
      if (socket.readyState !== WebSocket.OPEN) return
      connection.send({
        type: 'hello',
        resume: this.dependencies.tokens.resume(redeemed.id, grant),
        session: { id: session.id, name: session.name, tool: session.tool },
        target: { id: context.target.id, name: context.target.name },
      })
      const stream = await this.dependencies.sessions.attach(
        context,
        grant.sessionId,
        Number.isInteger(cols) ? Math.min(terminalService.maxCols, Math.max(2, cols)) : 80,
        Number.isInteger(rows) ? Math.min(terminalService.maxRows, Math.max(2, rows)) : 24,
        query.start === '1',
        connection.abort.signal,
      )
      connection.start(stream)
    } catch (error) {
      const failure = terminalFailure(error)
      connection.close(failure.reason, failure.message)
    }
  }

  /** Availability hints reach every authorized viewer of this managed session. */
  filesChanged(grant: Grant) {
    for (const connection of this.connections) {
      const other = connection.grant
      if (
        other.owner.userId === grant.owner.userId &&
        other.targetId === grant.targetId &&
        other.sessionId === grant.sessionId
      )
        connection.send({ type: 'signal', signal: { type: 'files.changed', payload: {} } })
    }
  }

  /** Close connections after a session is terminated or deleted, or a target removed. */
  closeTarget(owner: Owner, targetId: string, sessionId?: string) {
    for (const connection of this.connections) {
      const { grant } = connection
      if (
        grant.owner.userId === owner.userId &&
        grant.targetId === targetId &&
        (!sessionId || grant.sessionId === sessionId)
      ) {
        connection.close('ended', 'This session was stopped from Outpost.')
      }
    }
  }

  close() {
    this.stopped = true
    clearInterval(this.sweep)
    for (const connection of this.connections) connection.close('error', 'Outpost is restarting. Reconnecting…')
  }
}
