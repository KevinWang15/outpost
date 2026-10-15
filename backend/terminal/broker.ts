import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { WebSocket } from 'ws'
import { parseSessionActivity, unavailableActivity } from '../../shared/activity'
import type { ClientMessage, CloseReason, ServerMessage } from '../../shared/protocol'
import { maxInputMessage, protocolVersion } from '../../shared/protocol'
import { FrameDecoder, relayMagic, terminalControl, terminalFrame } from '../../shared/node/terminalFrames'
import { signalValidators } from '../../shared/signals'
import { terminalService, terminalSize } from '../../shared/terminalService'
import type { Deployment, Owner } from '../deployment'
import { AppError } from '../errors'
import { protocolResult } from '../process'
import { imageData, type SessionService, type TargetContext } from '../sessions'
import type { ConnectTokens, Grant } from './tokens'

const highWater = 1024 * 1024
const closedMessages: Record<'ended' | 'expired', string> = {
  ended: 'The coding tool exited. Connect again to start it in the same conversation.',
  expired: 'This connection expired. Click Connect in Outpost to open a new terminal.',
}

export interface TerminalQuery {
  token?: string
  cols?: string
  rows?: string
  protocol?: string
}

interface Dependencies {
  tokens: ConnectTokens
  deployment: Deployment
  sessions: SessionService
  resolve(owner: Owner, targetId: string): Promise<TargetContext>
  env?: NodeJS.ProcessEnv
}

/** One client socket attached to one relay process. Stateless by design
 * Closing either end ends both; the target terminal service keeps the session. */
class Connection {
  private child: ChildProcessWithoutNullStreams | null = null
  private decoder = new FrameDecoder()
  private prelude: Buffer = Buffer.alloc(0)
  private stderr = ''
  private started = false
  private pending: Buffer[] = []
  private unacked = 0
  private exitReason: 'ended' | null = null
  private finished = false
  private signals = { count: 0, until: 0 }
  private window = { messages: 0, bytes: 0, until: 0 }
  private heartbeat: NodeJS.Timeout
  private alive = true

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
    }, 30_000).unref()
  }

  send(message: ServerMessage) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  start(child: ChildProcessWithoutNullStreams, input?: Buffer) {
    if (this.finished) {
      child.kill()
      return
    }
    this.child = child
    child.stdin.on('error', () => {})
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => {
      this.stderr = (this.stderr + text).slice(-4096)
    })
    child.stdout.on('data', (chunk: Buffer) => this.output(chunk))
    child.on('error', error => this.close('error', `Could not reach the target: ${error.message}`))
    child.on('close', () => {
      if (this.exitReason) return this.close(this.exitReason, closedMessages[this.exitReason])
      if (!this.started) {
        let message = this.stderr.trim().split('\n').at(-1) || 'Could not attach to the session.'
        try {
          const result = protocolResult(this.prelude.toString('utf8'))
          if (result && !result.ok) message = result.error.message
        } catch {
          /* Keep the transport's own message. */
        }
        return this.close('error', message)
      }
      this.close('error', 'The connection to the target was lost.')
    })
    if (input) child.stdin.write(input)
  }

  private output(chunk: Buffer) {
    if (!this.started && !this.prelude.includes(relayMagic)) {
      // Login shells may print before the relay starts; keep a bounded tail for errors.
      this.prelude = Buffer.concat([this.prelude, chunk]).subarray(-64 * 1024)
      const start = this.prelude.indexOf(relayMagic)
      if (start < 0) return
      chunk = this.prelude.subarray(start + relayMagic.length)
      this.prelude = Buffer.from(relayMagic)
    }
    let frames
    try {
      frames = this.decoder.feed(chunk)
    } catch {
      return this.close('error', 'The target sent an invalid terminal stream.')
    }
    for (const { kind, payload } of frames) {
      if (kind === 'O') {
        if (this.socket.readyState !== WebSocket.OPEN) continue
        this.unacked += payload.length
        this.socket.send(payload)
        if (this.unacked > highWater) this.child?.stdout.pause()
      } else if (kind === 'C') {
        let message
        try {
          message = JSON.parse(payload.toString('utf8'))
        } catch {
          return this.close('error', 'The target sent an invalid control message.')
        }
        if (!message || typeof message !== 'object' || Array.isArray(message))
          return this.close('error', 'The target sent an invalid control message.')
        this.control(message)
      }
    }
  }

  private control(message: { type?: string; [key: string]: unknown }) {
    if (message.type === 'restore' || message.type === 'geometry') {
      const data = JSON.stringify(message)
      this.unacked += Buffer.byteLength(data)
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(data)
      if (this.unacked > highWater) this.child?.stdout.pause()
    } else if (message.type === 'error') {
      this.close('error', typeof message.message === 'string' ? message.message : 'Terminal service failed.')
    } else if (message.type === 'ready') {
      this.started = true
      for (const frame of this.pending) this.child!.stdin.write(frame)
      this.pending = []
      this.send({ type: 'ready' })
    } else if (message.type === 'activity') {
      this.send({
        type: 'activity',
        activity:
          parseSessionActivity(message.activity) ?? unavailableActivity('The target sent invalid activity metadata.'),
      })
    } else if (message.type === 'result' && typeof message.id === 'string') {
      this.send({
        type: 'result',
        id: message.id,
        ok: message.ok === true,
        ...(typeof message.reference === 'string' ? { reference: message.reference } : {}),
        ...(typeof message.message === 'string' ? { message: message.message } : {}),
      })
    } else if (message.type === 'signal' && typeof message.id === 'string') {
      const reply = (ok: boolean, text?: string) =>
        this.relay({ type: 'signal-result', id: message.id, ok, ...(text ? { message: text } : {}) })
      const signal = message.signal as { type?: unknown; payload?: unknown } | undefined
      const validate = typeof signal?.type === 'string' ? signalValidators[signal.type] : undefined
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
      this.exitReason = message.reason
    }
  }

  private relay(message: object) {
    this.write(terminalControl(message))
  }

  private write(frame: Buffer) {
    // Until the relay is ready (or even started), keep frames in order.
    if (this.started && this.child) this.child.stdin.write(frame)
    else if (this.pending.length < 256) this.pending.push(frame)
  }

  private receive(data: Buffer, binary: boolean) {
    const now = Date.now()
    if (this.window.until <= now) this.window = { messages: 0, bytes: 0, until: now + 1000 }
    if (++this.window.messages > 300) return this.socket.close(1008, 'Message rate exceeded')
    if (binary) {
      if (data.length > maxInputMessage || (this.window.bytes += data.length) > 1024 * 1024)
        return this.socket.close(1008, 'Input rate exceeded')
      return this.write(terminalFrame('I', data))
    }
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
    if (['ping', 'send', 'paste-image', 'activate', 'acknowledge'].includes(message.type) && id === undefined)
      return this.socket.close(1008, 'A terminal request ID is required')
    switch (message.type) {
      case 'ping':
        return this.send({ type: 'result', id: message.id, ok: true })
      case 'acknowledge':
        if (typeof message.completionId !== 'string' || !/^[a-f0-9]{64}$/.test(message.completionId))
          return this.socket.close(1008, 'Invalid activity acknowledgement')
        this.relay(message)
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
          this.relay({ type: 'resize', cols: message.cols, rows: message.rows })
        }
        return
      case 'ack':
        if (Number.isSafeInteger(message.bytes) && message.bytes >= 0) {
          this.unacked = Math.max(0, this.unacked - message.bytes)
          if (this.unacked <= highWater / 2) this.child?.stdout.resume()
        }
        return
      case 'send': {
        if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > maxInputMessage)
          return this.send({
            type: 'result',
            id: message.id,
            ok: false,
            message: 'Input must fit within 64 KiB. Send smaller sections.',
          })
        if (!this.started || !this.child?.stdin.writable)
          return this.send({
            type: 'result',
            id: message.id,
            ok: false,
            message: 'The terminal is not ready. Your draft is kept.',
          })
        this.relay(message)
        return
      }
      case 'paste-image': {
        let image
        try {
          image = imageData({ data: message.data, mediaType: message.mediaType })
        } catch (error) {
          return this.send({ type: 'result', id: message.id, ok: false, message: (error as Error).message })
        }
        if (!this.started)
          return this.send({
            type: 'result',
            id: message.id,
            ok: false,
            message: 'The terminal is not ready yet. Try again.',
          })
        return this.relay({ type: 'paste-image', id: message.id, ...image })
      }
      default:
        return this.socket.close(1008, 'Invalid terminal message')
    }
  }

  close(reason: CloseReason, message: string) {
    this.send({ type: 'closed', reason, message })
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, reason)
    this.finish()
  }

  private finish() {
    if (this.finished) return
    this.finished = true
    clearInterval(this.heartbeat)
    this.broker.forget(this)
    const child = this.child
    if (child && child.exitCode === null && child.signalCode === null) {
      // EOF closes the relay's socket; force it if the transport hangs.
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000).unref()
      child.once('close', () => clearTimeout(timer))
    }
  }
}

export class TerminalBroker {
  private connections = new Set<Connection>()
  private sweep: NodeJS.Timeout
  private stopped = false
  constructor(private dependencies: Dependencies) {
    this.sweep = setInterval(() => {
      for (const connection of this.connections) {
        if (!dependencies.deployment.active(connection.grant.owner))
          connection.close('expired', 'Sign-in ended. Sign in and connect again.')
      }
    }, 5000).unref()
  }
  forget(connection: Connection) {
    this.connections.delete(connection)
  }

  /** A fresh Connect can focus an existing tab without attaching another PTY. */
  activate(grant: Grant, token: string) {
    if (this.stopped || !this.dependencies.deployment.active(grant.owner)) return false
    const redeemed = this.dependencies.tokens.redeem(token, grant)
    if (!redeemed) return false
    this.dependencies.tokens.markConnected(redeemed.id, grant.owner)
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
    if (!redeemed || !this.dependencies.deployment.active(redeemed.grant.owner))
      return reject('expired', closedMessages.expired)
    const { grant } = redeemed
    if ([...this.connections].filter(connection => connection.grant.owner.userId === grant.owner.userId).length >= 16) {
      return reject('error', 'Too many open terminals. Close one and try again.')
    }
    const cols = Number(query.cols ?? 80),
      rows = Number(query.rows ?? 24)
    const connection = new Connection(grant, socket, this)
    this.connections.add(connection)
    try {
      const context = await this.dependencies.resolve(grant.owner, grant.targetId)
      const session = await this.dependencies.sessions.get(context, grant.sessionId)
      if (socket.readyState !== WebSocket.OPEN) return
      if (redeemed.kind === 'launch') this.dependencies.tokens.markConnected(redeemed.id, grant.owner)
      connection.send({
        type: 'hello',
        resume: this.dependencies.tokens.resume(redeemed.id, grant),
        session: { id: session.id, name: session.name },
        target: { id: context.target.id, name: context.target.name },
      })
      const command = this.dependencies.sessions.attach(
        context,
        grant.sessionId,
        Number.isInteger(cols) ? Math.min(terminalService.maxCols, Math.max(2, cols)) : 80,
        Number.isInteger(rows) ? Math.min(terminalService.maxRows, Math.max(2, rows)) : 24,
      )
      connection.start(
        spawn(command.executable, command.args, { stdio: 'pipe', env: this.dependencies.env ?? process.env }),
        command.input,
      )
    } catch (error) {
      connection.close(
        error instanceof AppError && error.statusCode === 404 ? 'ended' : 'error',
        (error as Error).message,
      )
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
