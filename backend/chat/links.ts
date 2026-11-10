import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ChatInfo, ChatEntry, ChatHostMessage, ChatHostRequest, DistributiveOmit } from '../../shared/chatHost'
import { chatHost, ChatJournal } from '../../shared/chatHost'
import type { LinkState } from '../../shared/chatApi'
import { BoundedWriter } from '../../shared/node/boundedWriter'
import { FrameDecoder, relayMagic, terminalControl } from '../../shared/node/terminalFrames'
import { AppError } from '../errors'
import { protocolResult } from '../process'
import type { SessionService, TargetContext } from '../sessions'

/** A framed byte stream to one chat host. */
export interface ChatTransport {
  send(message: ChatHostRequest): void
  close(): void
}
export interface ChatTransportEvents {
  message(message: ChatHostMessage): void
  /** `status` is the runtime's failure status before the stream started, if any. */
  closed(message: string, status: number | null): void
}
export type ChatConnector = (
  context: TargetContext,
  sessionId: string,
  start: boolean,
  events: ChatTransportEvents,
) => ChatTransport

/** The production path: the same transport as terminals, to the runtime's chat relay. */
export function relayConnector(sessions: SessionService, env?: NodeJS.ProcessEnv): ChatConnector {
  return (context, sessionId, start, events) => {
    const command = sessions.chatAttach(context, sessionId, start)
    const child = spawn(command.executable, command.args, { stdio: 'pipe', env: env ?? process.env })
    let prelude: Buffer = Buffer.alloc(0)
    let started = false
    let stderr = ''
    let finished = false
    const decoder = new FrameDecoder()
    const finish = (message: string, status: number | null) => {
      if (finished) return
      finished = true
      writer.dispose()
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.destroy()
        setTimeout(() => child.kill('SIGKILL'), 5000).unref()
      }
      events.closed(message, status)
    }
    const writer = new BoundedWriter(child.stdin, 64 * 1024 * 1024, 30_000, message => finish(message, null))
    if (command.input) writer.write(command.input)
    child.stdin.on('error', () => finish('The connection to the target stopped accepting input.', null))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => {
      stderr = (stderr + text).slice(-4096)
    })
    child.on('error', error => finish(`Could not reach the target: ${error.message}`, null))
    child.stdout.on('data', (chunk: Buffer) => {
      if (finished) return
      if (!started) {
        prelude = Buffer.concat([prelude, chunk]).subarray(-64 * 1024)
        const at = prelude.indexOf(relayMagic)
        if (at < 0) return
        started = true
        chunk = prelude.subarray(at + relayMagic.length)
        prelude = Buffer.alloc(0)
      }
      try {
        for (const frame of decoder.feed(chunk)) {
          if (frame.kind !== 'C') throw new Error('Invalid chat frame')
          events.message(JSON.parse(frame.payload.toString('utf8')))
        }
      } catch {
        finish('The target sent an invalid chat stream.', 502)
      }
    })
    child.on('close', () => {
      if (started) return finish('The connection to the chat was lost.', null)
      try {
        const result = protocolResult(prelude.toString('utf8'))
        if (result && !result.ok) return finish(result.error.message, result.error.statusCode)
      } catch {
        /* Keep the transport's own message. */
      }
      finish(stderr.trim().split('\n').at(-1) || 'Could not open the chat.', null)
    })
    return {
      send: message => void writer.write(terminalControl(message)),
      close: () => finish('Closed.', null),
    }
  }
}

export type LinkEvent =
  | { type: 'journal' }
  | { type: 'entry'; entry: ChatEntry }
  | { type: 'info'; info: ChatInfo }
  | { type: 'link'; state: LinkState; message: string | null }

interface Pending {
  resolve(value: { ok: boolean; message?: string; data?: unknown }): void
  timer: NodeJS.Timeout
}

const idleMs = 60_000
const retryMs = [1000, 2000, 5000, 10_000, 30_000]

/** The server's one connection to a session's chat host, shared by every
 * viewer and by channel routing. It mirrors the host's journal. */
export class ChatLink {
  readonly journal = new ChatJournal()
  info: ChatInfo | null = null
  state: LinkState = 'starting'
  message: string | null = null
  private transport: ChatTransport | null = null
  private listeners = new Set<(event: LinkEvent) => void>()
  private holds = new Set<string>()
  private pending = new Map<string, Pending>()
  private queued: ChatHostRequest[] = []
  private idle: NodeJS.Timeout | null = null
  private retry: NodeJS.Timeout | null = null
  private failures = 0
  private disposed = false

  constructor(
    readonly key: string,
    private open: (start: boolean, events: ChatTransportEvents) => ChatTransport,
    private hooks: {
      /** An Outpost MCP call from the session's agent. */
      call(link: ChatLink, message: Extract<ChatHostMessage, { type: 'call' }>): void
      /** Every journal change, for channel routing. */
      changed(link: ChatLink, event: LinkEvent): void
      disposed(link: ChatLink): void
    },
  ) {}

  /** Connect if needed. `start` restarts a stopped coding tool. */
  ensure(start: boolean) {
    if (this.disposed) return
    if (this.transport && this.state !== 'stopped' && this.state !== 'unavailable') return
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.setState('starting', null)
    const transport = this.open(start, {
      message: message => {
        if (this.transport === transport) this.receive(message)
      },
      closed: (message, status) => {
        if (this.transport !== transport) return
        this.transport = null
        this.closed(message, status)
      },
    })
    this.transport = transport
    transport.send({ type: 'hello', protocol: chatHost.protocol, role: 'hub' })
  }

  private receive(message: ChatHostMessage) {
    switch (message.type) {
      case 'welcome':
        this.failures = 0
        this.journal.load(message.journal)
        this.info = message.info
        this.setState('live', null)
        this.emit({ type: 'journal' })
        for (const request of this.queued.splice(0)) this.transport?.send(request)
        return
      case 'entry':
        if (!this.journal.accept(message.entry)) {
          // A gap: reconnect for a fresh snapshot rather than guess.
          this.transport?.close()
          return
        }
        return this.emit({ type: 'entry', entry: message.entry })
      case 'info':
        this.info = message.info
        return this.emit({ type: 'info', info: message.info })
      case 'result': {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        return pending.resolve({ ok: message.ok, message: message.message, data: message.data })
      }
      case 'call':
        return this.hooks.call(this, message)
      case 'error':
        this.message = message.message
        return
    }
  }

  private closed(message: string, status: number | null) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, message: 'The connection to the chat was lost. Check before retrying.' })
      this.pending.delete(id)
    }
    const ended = this.info?.state === 'exited' || this.info?.state === 'failed'
    if (status === 410 || ended) {
      this.setState('stopped', this.info?.error ?? (status === 410 ? message : null))
    } else if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      this.setState('unavailable', this.message ?? message)
    } else if (this.needed()) {
      // Transient transport failure: reconnect without restarting a stopped tool.
      this.setState('starting', message)
      const delay = retryMs[Math.min(this.failures++, retryMs.length - 1)]
      this.retry = setTimeout(() => {
        this.retry = null
        this.ensure(false)
      }, delay)
      this.retry.unref()
    } else this.setState('stopped', null)
    this.message = null
    this.schedule()
  }

  private setState(state: LinkState, message: string | null) {
    if (this.state === state && this.message === message) return
    this.state = state
    this.message = message
    this.emit({ type: 'link', state, message })
  }

  private emit(event: LinkEvent) {
    this.hooks.changed(this, event)
    for (const listener of this.listeners) listener(event)
    if (event.type === 'info') this.schedule()
  }

  // Lifetime ---------------------------------------------------------------------------

  subscribe(listener: (event: LinkEvent) => void) {
    this.listeners.add(listener)
    this.schedule()
    return () => {
      this.listeners.delete(listener)
      this.schedule()
    }
  }

  hold(reason: string) {
    this.holds.add(reason)
    this.schedule()
  }

  release(reason: string) {
    this.holds.delete(reason)
    this.schedule()
  }

  private busy() {
    const state = this.info?.activity.state
    return (
      state === 'working' || state === 'waiting' || this.info?.state === 'identity' || this.info?.state === 'starting'
    )
  }

  private needed() {
    return this.listeners.size > 0 || this.holds.size > 0 || this.busy()
  }

  /** Close after a minute without viewers, routing work or a running turn. */
  private schedule() {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    if (this.disposed || this.needed()) return
    this.idle = setTimeout(() => this.dispose(), idleMs)
    this.idle.unref()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.idle) clearTimeout(this.idle)
    if (this.retry) clearTimeout(this.retry)
    const transport = this.transport
    this.transport = null
    transport?.close()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, message: 'The chat closed.' })
    }
    this.pending.clear()
    this.hooks.disposed(this)
  }

  // Requests ---------------------------------------------------------------------------

  /** Send a request; it waits for the connection while the link starts. */
  request(
    message: DistributiveOmit<Exclude<ChatHostRequest, { type: 'hello' | 'status' | 'identity-saved' }>, 'id'>,
    timeoutMs = 30_000,
  ) {
    const id = randomUUID()
    const full = { ...message, id } as ChatHostRequest
    return new Promise<{ ok: boolean; message?: string; data?: unknown }>(resolve => {
      if (this.disposed || this.state === 'stopped' || this.state === 'unavailable')
        return resolve({ ok: false, message: this.message ?? 'The chat is not running. Open it to start it.' })
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, message: 'The chat did not answer in time. Check before retrying.' })
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, { resolve, timer })
      if (this.state === 'live' && this.transport) this.transport.send(full)
      else this.queued.push(full)
    })
  }

  /** Answer an MCP call the host forwarded. */
  answer(id: string, ok: boolean, message?: string, data?: unknown) {
    this.transport?.send({
      type: 'answer',
      id,
      ok,
      ...(message ? { message } : {}),
      ...(data !== undefined ? { data } : {}),
    })
  }

  /** One-way requests (seen). */
  notify(message: ChatHostRequest) {
    if (this.state === 'live') this.transport?.send(message)
  }
}

export const linkFailure = (state: LinkState, message: string | null) =>
  new AppError(message ?? (state === 'stopped' ? 'The chat is not running.' : 'The chat is unavailable.'), 409)
