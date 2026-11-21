// The one connection Outpost keeps to each machine an account uses: the node
// (`outpost-terminal node`) run over the machine's transport, carrying calls,
// streams and agents' tool calls (docs/ARCHITECTURE.md, "Machines").
import type { Duplex } from 'node:stream'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import {
  machineProtocol,
  nodeMagic,
  type AgentCall,
  type MachineMessage,
  type RemoteError,
  type StreamKind,
} from '../shared/machine'
import { BoundedWriter } from '../shared/node/boundedWriter'
import { FrameDecoder, terminalControl, terminalFrame } from '../shared/node/terminalFrames'
import { terminalService } from '../shared/terminalService'
import type { Owner } from './deployment'
import { AppError } from './errors'
import type { Command } from './process'
import type { Transport } from './transport'

const magic = Buffer.from(nodeMagic, 'latin1')

export class MachineError extends AppError {}
const remote = (error: RemoteError) => new MachineError(error.message, error.status)

/** A byte stream to a machine: what callers of `open` use. */
export interface Stream {
  /** The node's answer to the open. */
  readonly opened: unknown
  onData(listener: (bytes: Buffer) => void): void
  onClose(listener: (error: MachineError | null, data: unknown) => void): void
  write(bytes: Buffer): void
  /** Finish sending; a receiving node answers in its close. */
  end(): void
  pause(): void
  resume(): void
}

/** One stream on a machine connection. Data is delivered in order; the
 * receiver's pace is the sender's: a paused stream grants no more window. */
class MachineStream implements Stream {
  private paused = false
  private owed = 0
  private listeners: { data?: (bytes: Buffer) => void; close?: (error: MachineError | null, data: unknown) => void } =
    {}
  private closed = false
  private buffered: Buffer[] = []
  private ending: { error: MachineError | null; data: unknown } | null = null

  constructor(
    readonly id: number,
    readonly opened: unknown,
    private connection: MachineConnection,
  ) {}

  onData(listener: (bytes: Buffer) => void) {
    this.listeners.data = listener
    for (const bytes of this.buffered.splice(0)) this.deliver(bytes)
  }
  onClose(listener: (error: MachineError | null, data: unknown) => void) {
    this.listeners.close = listener
    if (this.ending) listener(this.ending.error, this.ending.data)
  }
  write(bytes: Buffer) {
    if (!this.closed) this.connection.data(this.id, bytes)
  }
  end() {
    if (this.closed) return
    this.closed = true
    this.connection.send({ type: 'close', stream: this.id })
  }
  pause() {
    this.paused = true
  }
  resume() {
    this.paused = false
    if (this.owed) this.connection.send({ type: 'credit', stream: this.id, bytes: this.owed })
    this.owed = 0
  }

  /** From the connection. */
  deliver(bytes: Buffer) {
    if (!this.listeners.data) return void this.buffered.push(bytes)
    this.listeners.data(bytes)
    if (this.paused) this.owed += bytes.length
    else this.connection.send({ type: 'credit', stream: this.id, bytes: bytes.length })
  }
  finish(error: MachineError | null, data: unknown) {
    if (this.ending) return
    this.closed = true
    this.ending = { error, data }
    this.listeners.close?.(error, data)
  }
}

interface Options {
  env?: NodeJS.ProcessEnv
  /** An agent on this machine called an Outpost tool. */
  agent(call: AgentCall): Promise<unknown>
  /** The machine has events to read: it connected, or its event log grew. */
  events(): void
}

export class MachineConnection {
  private child: ChildProcessWithoutNullStreams | null = null
  directOrigin?: string
  private incoming: Duplex | null = null
  private writer: BoundedWriter | null = null
  private starting: Promise<void> | null = null
  private startFailed: ((error: Error) => void) | null = null
  private decoder = new FrameDecoder()
  private prelude = Buffer.alloc(0)
  private sawMagic = false
  private started = false
  private stderr = ''
  private calls = new Map<string, { resolve(data: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  private opening = new Map<number, { resolve(stream: MachineStream): void; reject(error: Error): void }>()
  private streams = new Map<number, MachineStream>()
  private nextStream = 1
  private closed = false

  constructor(
    readonly socket: string,
    private transport: Transport,
    private options: Options,
  ) {}

  /** The authenticated connector supplies the same framed node protocol as SSH. */
  register(stream: Duplex) {
    this.restart()
    this.incoming = stream
    this.decoder = new FrameDecoder()
    this.prelude = Buffer.alloc(0)
    this.sawMagic = false
    this.started = false
    const timer = setTimeout(() => {
      if (this.incoming === stream) this.lost('The relay-enabled machine did not finish its handshake.')
    }, 10_000).unref()
    this.writer = new BoundedWriter(stream, 64 * 1024 * 1024, 30_000, message => this.lost(message))
    stream.on('data', (bytes: Buffer) => {
      if (this.incoming !== stream) return
      try {
        this.output(bytes, () => {}, timer)
      } catch {
        this.lost('The relay-enabled machine sent an invalid node message.')
      }
    })
    const ended = () => {
      clearTimeout(timer)
      if (this.incoming === stream) this.lost('The relay-enabled machine disconnected.')
    }
    stream.on('error', ended)
    stream.once('close', ended)
    stream.once('end', ended)
  }

  /** Connect if needed; resolves once the node said hello. */
  private connect() {
    if (this.closed) return Promise.reject(new MachineError('Outpost is restarting. Try again shortly.', 503))
    if (this.incoming && !this.started)
      return Promise.reject(new MachineError('The relay-enabled machine is connecting.', 503))
    if ((this.child || this.incoming) && this.started) return Promise.resolve()
    this.starting ??= new Promise<void>((resolve, reject) => {
      const command = this.transport.login(`exec "$HOME/.outpost/bin/outpost-terminal" node --socket ${this.socket}`)
      const timer = setTimeout(
        () => this.lost('The machine did not answer in time. Check that it is reachable.'),
        30_000,
      )
      const fail = (error: Error) => {
        clearTimeout(timer)
        this.startFailed = null
        reject(error)
      }
      this.startFailed = fail
      const launch = (args: string[], retry: Command['retry']) => {
        const child = spawn(command.executable, args, { stdio: 'pipe', env: this.options.env ?? process.env })
        this.child = child
        this.sawMagic = false
        this.started = false
        this.prelude = Buffer.alloc(0)
        this.decoder = new FrameDecoder()
        this.stderr = ''
        let printed = false
        this.writer = new BoundedWriter(child.stdin, 64 * 1024 * 1024, 30_000, message => this.lost(message))
        child.stdin.on('error', () => {})
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (text: string) => (this.stderr = (this.stderr + text).slice(-4096)))
        child.stdout.on('data', (bytes: Buffer) => {
          if (this.child !== child) return
          printed = true
          try {
            this.output(bytes, resolve, timer)
          } catch {
            this.lost('The machine sent an invalid node message.')
          }
        })
        child.on('error', error => this.child === child && this.lost(`Could not reach the machine: ${error.message}`))
        child.on('close', code => {
          if (this.child !== child) return
          const stderr = this.stderr.trim()
          // A stale shared SSH connection: try once more without sharing.
          if (!this.started && retry?.when({ code, stdout: printed ? '.' : '', stderr })) {
            this.writer?.dispose()
            return launch(retry.args, undefined)
          }
          const message = !this.started
            ? code === 127 || code === 126 || /outpost-terminal: (not found|No such file)/.test(stderr)
              ? 'Outpost machine service is missing on this machine. Open Required software to install it.'
              : stderr.split('\n').at(-1) || 'Could not connect to the machine. Check access and Required software.'
            : 'The connection to the machine was lost.'
          this.lost(message)
        })
      }
      launch(command.args, command.retry)
    }).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private output(bytes: Buffer, ready: () => void, timer: NodeJS.Timeout) {
    if (!this.sawMagic) {
      // Login shells may print before the node starts; keep a bounded tail.
      this.prelude = Buffer.concat([this.prelude, bytes])
      const at = this.prelude.indexOf(magic)
      if (at < 0) {
        this.prelude = this.prelude.subarray(-magic.length)
        return
      }
      bytes = this.prelude.subarray(at + magic.length)
      this.prelude = Buffer.alloc(0)
      this.sawMagic = true
    }
    let frames
    try {
      frames = this.decoder.feed(bytes)
    } catch {
      return this.lost('The machine sent an invalid stream.')
    }
    for (const frame of frames) {
      if (frame.kind === 'D') {
        if (!this.started || frame.payload.length < 4) return this.lost('Unexpected machine data.')
        this.streams.get(frame.payload.readUInt32BE(0))?.deliver(Buffer.from(frame.payload.subarray(4)))
        continue
      }
      if (frame.kind !== 'C') return this.lost('The machine sent an invalid frame.')
      const message = JSON.parse(frame.payload.toString('utf8')) as MachineMessage
      if (message.type === 'hello') {
        if (this.started) return this.lost('Duplicate machine handshake.')
        clearTimeout(timer)
        if (message.version !== terminalService.version || message.protocol !== machineProtocol) {
          const problem = `This machine runs Outpost machine service ${message.version}; ${terminalService.version} is required. Open Required software to install it.`
          this.lost(problem, 409)
          return
        }
        this.started = true
        this.directOrigin = this.incoming && typeof message.directOrigin === 'string' ? message.directOrigin : undefined
        this.startFailed = null
        ready()
        this.options.events()
        continue
      }
      if (!this.started) return this.lost('Expected a machine handshake.')
      this.receive(message)
    }
  }

  private receive(message: MachineMessage) {
    switch (message.type) {
      case 'result': {
        const waiter = this.calls.get(message.id)
        if (!waiter) return
        this.calls.delete(message.id)
        clearTimeout(waiter.timer)
        if (message.ok) waiter.resolve(message.data)
        else waiter.reject(remote(message.error))
        return
      }
      case 'opened': {
        const waiter = this.opening.get(message.stream)
        if (!waiter) return
        this.opening.delete(message.stream)
        const stream = new MachineStream(message.stream, message.data, this)
        this.streams.set(message.stream, stream)
        waiter.resolve(stream)
        return
      }
      case 'close': {
        const error = message.error ? remote(message.error) : null
        const waiter = this.opening.get(message.stream)
        if (waiter) {
          this.opening.delete(message.stream)
          return waiter.reject(error ?? new MachineError('The machine closed the stream.', 502))
        }
        const stream = this.streams.get(message.stream)
        this.streams.delete(message.stream)
        return stream?.finish(error, message.data)
      }
      case 'events':
        return this.options.events()
      case 'call': {
        // The node asks on behalf of an agent; answer like any other call.
        const answer = (result: { ok: true; data: unknown } | { ok: false; error: RemoteError }) =>
          this.send({ type: 'result', id: message.id, ...result })
        if (message.op !== 'agent') return answer({ ok: false, error: { message: 'Unknown request', status: 400 } })
        this.options.agent(message.args as AgentCall).then(
          data => answer({ ok: true, data: data ?? null }),
          error => answer({ ok: false, error: { message: (error as Error).message.slice(0, 4000), status: 400 } }),
        )
        return
      }
    }
  }

  send(message: MachineMessage) {
    this.writer?.write(terminalControl(message))
  }
  data(stream: number, bytes: Buffer) {
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      const prefix = Buffer.alloc(4)
      prefix.writeUInt32BE(stream)
      this.writer?.write(terminalFrame('D', Buffer.concat([prefix, bytes.subarray(offset, offset + 64 * 1024)])))
    }
  }

  /** The connection ended: every caller learns now; the next use reconnects. */
  private lost(message: string, status = 502) {
    const child = this.child
    const incoming = this.incoming
    if (!child && !incoming) return
    this.incoming = null
    this.directOrigin = undefined
    this.child = null
    incoming?.destroy()
    this.startFailed?.(new MachineError(message, status))
    this.started = false
    this.writer?.dispose()
    this.writer = null
    if (child) {
      child.stdin.destroy()
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000).unref()
    }
    const error = new MachineError(message, status)
    for (const waiter of this.calls.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.calls.clear()
    for (const waiter of this.opening.values()) waiter.reject(error)
    this.opening.clear()
    for (const stream of this.streams.values()) stream.finish(error, null)
    this.streams.clear()
  }

  async call<T>(op: string, args: object = {}, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    options.signal?.throwIfAborted()
    await this.connect()
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.calls.delete(id)
        reject(new MachineError('The machine did not answer in time. Check it and retry.', 504))
      }, options.timeoutMs ?? 30_000)
      this.calls.set(id, { resolve: resolve as (data: unknown) => void, reject, timer })
      options.signal?.addEventListener(
        'abort',
        () => {
          if (!this.calls.delete(id)) return
          clearTimeout(timer)
          reject(new MachineError('The operation was cancelled.', 499))
        },
        { once: true },
      )
      this.send({ type: 'call', id, op, args })
    })
  }

  async open(kind: StreamKind, args: object, signal?: AbortSignal): Promise<MachineStream> {
    signal?.throwIfAborted()
    await this.connect()
    const stream = this.nextStream++
    return new Promise<MachineStream>((resolve, reject) => {
      this.opening.set(stream, { resolve, reject })
      signal?.addEventListener(
        'abort',
        () => {
          if (!this.opening.delete(stream)) return
          this.send({ type: 'close', stream })
          reject(new MachineError('The operation was cancelled.', 499))
        },
        { once: true },
      )
      this.send({ type: 'open', stream, kind, args })
    })
  }

  close() {
    this.closed = true
    this.lost('Outpost is restarting. Try again shortly.')
  }
  /** Drop the current connection; the next use starts a new node (after an update). */
  restart() {
    this.lost('Outpost machine service was updated. Reconnecting…')
  }
}

/** Every account's machine connections. */
export function managedSocket(secret: string, owner: Owner, targetId: string) {
  return `run/node-${createHmac('sha256', secret).update(`node\0${owner.userId}\0${targetId}`).digest('hex').slice(0, 32)}.sock`
}

export class Machines {
  private connections = new Map<string, MachineConnection>()
  /** Answers agents' tool calls; set once the hubs exist. */
  agent: (owner: Owner, targetId: string, call: AgentCall) => Promise<unknown> = async () => {
    throw new Error('Outpost is starting. Try again shortly.')
  }
  /** Reads a machine's events when it has some; set once the activity log exists. */
  events: (owner: Owner, targetId: string) => void = () => {}

  constructor(
    private secret: string,
    private env?: NodeJS.ProcessEnv,
  ) {}

  get(owner: Owner, targetId: string, transport: Transport) {
    const key = `${owner.userId}\0${targetId}`
    let connection = this.connections.get(key)
    if (!connection) {
      // This stable node identity is pinned by the machine installation.
      const socket = managedSocket(this.secret, owner, targetId)
      connection = new MachineConnection(socket, transport, {
        env: this.env,
        agent: call => this.agent(owner, targetId, call),
        events: () => this.events(owner, targetId),
      })
      this.connections.set(key, connection)
    }
    return connection
  }

  directOrigins(owner: Owner) {
    const origins = new Set<string>()
    for (const [key, machine] of this.connections) {
      if (!key.startsWith(owner.userId + '\0') || !machine.directOrigin) continue
      try {
        const url = new URL(machine.directOrigin)
        if (url.protocol === 'https:' && /^[a-z0-9.:[\]-]+$/i.test(url.host))
          origins.add('wss://' + url.host + '/api/terminal/direct')
      } catch {
        /* Ignore malformed endpoint advertisements. */
      }
    }
    return [...origins]
  }

  /** A target was removed or its software changed. */
  forget(owner: Owner, targetId: string) {
    const key = `${owner.userId}\0${targetId}`
    this.connections.get(key)?.close()
    this.connections.delete(key)
  }
  restart(owner: Owner, targetId: string) {
    this.connections.get(`${owner.userId}\0${targetId}`)?.restart()
  }

  close() {
    for (const connection of this.connections.values()) connection.close()
    this.connections.clear()
  }
}
