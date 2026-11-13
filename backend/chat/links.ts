import { randomUUID } from 'node:crypto'
import type { ChatInfo, ChatEntry, ChatHostMessage, ChatHostRequest, DistributiveOmit } from '../../shared/chatHost'
import { chatHost, ChatJournal } from '../../shared/chatHost'
import type { LinkState } from '../../shared/chatApi'
import { FrameDecoder, terminalControl } from '../../shared/node/terminalFrames'
import { terminalConnectionPolicy } from '../../shared/protocol'
import { AppError } from '../errors'
import type { Stream } from '../machines'
import type { SessionService, TargetContext } from '../sessions'

/** A framed byte stream to one chat host. */
export interface ChatTransport {
  send(message: ChatHostRequest): void
  close(reason?: string): void
}
export interface ChatTransportEvents {
  /** Bytes arrived; a large frame can take a while on a slow link. */
  progress(): void
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

/** The production path: a chat stream on the session machine's connection. */
export function machineConnector(sessions: SessionService): ChatConnector {
  return (context, sessionId, start, events) => {
    let stream: Stream | null = null
    let finished = false
    const waiting: Buffer[] = []
    const decoder = new FrameDecoder()
    const finish = (message: string, status: number | null) => {
      if (finished) return
      finished = true
      stream?.end()
      events.closed(message, status)
    }
    const write = (frame: Buffer) => (stream ? stream.write(frame) : waiting.push(frame))
    sessions.chatAttach(context, sessionId, start).then(
      opened => {
        if (finished) return opened.end()
        stream = opened
        for (const frame of waiting.splice(0)) opened.write(frame)
        opened.onData(chunk => {
          if (finished) return
          events.progress()
          try {
            for (const frame of decoder.feed(chunk)) {
              if (frame.kind !== 'C') throw new Error('Invalid chat frame')
              events.message(JSON.parse(frame.payload.toString('utf8')))
            }
          } catch {
            finish('The machine sent an invalid chat stream.', 502)
          }
        })
        opened.onClose(error => finish(error?.message ?? 'The connection to the chat was lost.', null))
      },
      error => finish((error as Error).message, error instanceof AppError ? error.statusCode : null),
    )
    return {
      send: message => void write(terminalControl(message)),
      close: (reason = 'Closed.') => finish(reason, null),
    }
  }
}

export type LinkEvent =
  | { type: 'journal' }
  | { type: 'entry'; entry: ChatEntry }
  | { type: 'info'; info: ChatInfo }
  | { type: 'link'; state: LinkState; message: string | null }

/** `unknown`: the request reached a host but no answer came back, so it may have
 * taken effect. Without it, a failed result means the host never acted. */
export interface LinkResult {
  ok: boolean
  message?: string
  data?: unknown
  unknown?: boolean
}

interface Pending {
  resolve(value: LinkResult): void
  timer: NodeJS.Timeout
  request: ChatHostRequest
  /** The host instance it was sent to; null while it waits for the connection. */
  sent: string | null
  onSent?: (instance: string) => void
}

const unanswered = 'The chat did not confirm this. Check before retrying.'

const idleMs = 60_000
const retryMs = [1000, 2000, 5000, 10_000, 30_000]

/** The server's one connection to a session's chat host, shared by every
 * viewer and by channel routing. It mirrors the host's journal. */
export class ChatLink {
  readonly journal = new ChatJournal()
  info: ChatInfo | null = null
  state: LinkState = 'starting'
  message: string | null = null
  /** The connected host process, from its welcome. */
  instance: string | null = null
  private transport: ChatTransport | null = null
  private listeners = new Set<(event: LinkEvent) => void>()
  private holds = new Set<string>()
  private pending = new Map<string, Pending>()
  private idle: NodeJS.Timeout | null = null
  private retry: NodeJS.Timeout | null = null
  private failures = 0
  private disposed = false
  /** Liveness, as for terminals: when bytes last arrived, and an unanswered ping. */
  private heard = 0
  private probe: string | null = null
  private watch: NodeJS.Timeout | null = null

  constructor(
    readonly key: string,
    private open: (start: boolean, events: ChatTransportEvents) => ChatTransport,
    private hooks: {
      /** Every journal change, for channel routing. */
      changed(link: ChatLink, event: LinkEvent): void
      disposed(link: ChatLink): void
    },
    private probeMs: number = terminalConnectionPolicy.probeMs,
  ) {}

  /** Connect if needed. `start` restarts a stopped coding tool. */
  ensure(start: boolean) {
    if (this.disposed) return
    if (this.transport && this.state !== 'stopped' && this.state !== 'unavailable') return
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.setState('starting', null)
    this.heard = Date.now()
    this.probe = null
    this.watch ??= setInterval(() => this.check(), this.probeMs / 6)
    this.watch.unref()
    const transport = this.open(start, {
      progress: () => {
        if (this.transport === transport) this.heard = Date.now()
      },
      message: message => {
        if (this.transport !== transport) return
        if (message.type === 'result' && message.id === this.probe) this.probe = null
        else this.receive(message)
      },
      closed: (message, status) => {
        if (this.transport !== transport) return
        this.transport = null
        this.closed(message, status)
      },
    })
    this.transport = transport
    transport.send({ type: 'hello', protocol: chatHost.protocol })
  }

  /** A quiet connection gets a ping; one that stays silent is replaced. Before
   * the welcome, the target has the attach time to start the chat. */
  private check() {
    const transport = this.transport
    if (!transport) return
    const quiet = Date.now() - this.heard
    if (this.state !== 'live') {
      if (quiet > 2 * this.probeMs) transport.close('The chat did not start in time.')
    } else if (quiet > this.probeMs) transport.close('The chat stopped responding.')
    else if (quiet > this.probeMs / 2 && !this.probe) {
      this.probe = randomUUID()
      transport.send({ type: 'ping', id: this.probe })
    }
  }

  private receive(message: ChatHostMessage) {
    switch (message.type) {
      case 'welcome':
        this.failures = 0
        this.journal.load(message.journal)
        this.info = message.info
        this.instance = message.instance
        this.setState('live', null)
        this.emit({ type: 'journal' })
        for (const pending of this.pending.values()) if (!pending.sent) this.transmit(pending)
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
        return this.settle(message.id, { ok: message.ok, message: message.message, data: message.data })
      }
      case 'error':
        this.message = message.message
        return
    }
  }

  private closed(message: string, status: number | null) {
    // Requests already sent may have taken effect; unsent ones wait for the reconnect.
    for (const [id, pending] of this.pending)
      if (pending.sent) this.settle(id, { ok: false, message: unanswered, unknown: true })
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
    if (this.state === 'stopped' || this.state === 'unavailable')
      for (const id of [...this.pending.keys()])
        this.settle(id, { ok: false, message: this.message ?? 'The chat is not running. Open it to start it.' })
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
    return state === 'working' || state === 'waiting' || this.info?.state === 'starting'
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
    if (this.watch) clearInterval(this.watch)
    const transport = this.transport
    this.transport = null
    transport?.close()
    for (const [id, pending] of this.pending)
      this.settle(
        id,
        pending.sent ? { ok: false, message: unanswered, unknown: true } : { ok: false, message: 'The chat closed.' },
      )
    this.hooks.disposed(this)
  }

  // Requests ---------------------------------------------------------------------------

  /** Send a request; it waits for the connection while the link starts. `onSent`
   * runs when it is written to a host, with that host's instance. */
  request(
    message: DistributiveOmit<Exclude<ChatHostRequest, { type: 'hello' | 'status' | 'stop' | 'file' }>, 'id'>,
    timeoutMs = 30_000,
    onSent?: (instance: string) => void,
  ) {
    const id = randomUUID()
    const request = { ...message, id } as ChatHostRequest
    return new Promise<LinkResult>(resolve => {
      if (this.disposed || this.state === 'stopped' || this.state === 'unavailable')
        return resolve({ ok: false, message: this.message ?? 'The chat is not running. Open it to start it.' })
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (pending)
          this.settle(
            id,
            pending.sent
              ? { ok: false, message: unanswered, unknown: true }
              : { ok: false, message: 'The chat did not start in time.' },
          )
      }, timeoutMs)
      timer.unref()
      const pending: Pending = { resolve, timer, request, sent: null, onSent }
      this.pending.set(id, pending)
      if (this.state === 'live') this.transmit(pending)
    })
  }

  private transmit(pending: Pending) {
    if (!this.transport || !this.instance) return
    pending.sent = this.instance
    this.transport.send(pending.request)
    pending.onSent?.(this.instance)
  }

  private settle(id: string, result: LinkResult) {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(result)
  }
}
