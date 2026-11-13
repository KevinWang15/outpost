// The activity log: one log-viewer stream per account, mounted at /log-viewer,
// fed in-process by everything that records an event, and passed on to the
// account's webhooks. Each account reads only its own stream.
import { createHmac, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { createLogViewer, type LogViewer, type StreamEntryInput } from '@kevinwang15/log-viewer'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { LogEvent, LogLevel, LogView } from '../../shared/logs'
import type { Caller, Deployment, Owner } from '../deployment'
import { Webhooks } from './webhooks'

export type LogInput = Omit<LogEvent, 'id' | 'time' | 'level' | 'machine' | 'session' | 'details'> & {
  time?: string
  level?: LogLevel
  machine?: LogEvent['machine']
  session?: LogEvent['session']
  details?: LogEvent['details']
}

const mount = '/log-viewer'
const levelNames: Record<LogLevel, string> = { info: 'INFO', warning: 'WARN', error: 'ERROR' }

/** How the viewer stores and shows an event. */
function entry(event: LogEvent): StreamEntryInput {
  const fields: Record<string, string | number | boolean | null> = { type: event.type }
  if (event.machine) fields.machine = event.machine.name
  if (event.session) fields.session = event.session.name
  for (const [key, value] of Object.entries(event.details).slice(0, 24)) fields[key] = value
  return {
    time: event.time,
    level: levelNames[event.level],
    logger: event.kind,
    thread: event.machine?.name ?? 'Outpost',
    message: event.message,
    fields,
  }
}

export class ActivityLog {
  readonly webhooks: Webhooks
  private viewer: LogViewer
  /** The viewer's upgrade handler, for WebSocket connections at /log-viewer/ws. */
  private upgrade: ((request: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null

  constructor(
    private deployment: Deployment,
    /** Reads request cookies the way the app does. */
    private cookies: (header: string) => Record<string, string | undefined>,
  ) {
    this.webhooks = new Webhooks(deployment)
    this.webhooks.failed = (owner, webhook, delivery) =>
      this.record(
        owner,
        {
          level: 'warning',
          kind: 'webhook',
          type: 'failed',
          message: `Webhook ${webhook.name} could not deliver an event: ${delivery.error}`,
          details: { webhook: webhook.name, status: delivery.status, error: delivery.error },
        },
        webhook.id,
      )
    this.viewer = createLogViewer({
      authorize: async context => {
        if (!context.req) return false
        let owner: Owner
        try {
          owner = this.deployment.owner(this.caller(context.req))
        } catch {
          return { status: 401, error: 'Sign in to continue.' }
        }
        const own = `s:${this.channel(owner)}`
        // An account reads its own stream and keeps filters and bookmarks on it.
        // Everything else (opening files, ingesting, rules and their webhooks) is Outpost's.
        if (context.action === 'read') return context.source ? context.source.id === own : context.transport === 'http'
        if (context.action === 'view-state') return context.source?.id === own
        return false
      },
      streams: {
        maxSources: 0,
        maxEntries: 50_000,
        maxBytes: 32 * 1024 * 1024,
        idleTtlSeconds: 0,
        spoolDir: join(deployment.directory, 'logs'),
        mutationAuth: 'custom',
      },
      merge: false,
      logger: { log() {}, warn: console.warn, error: console.error },
    })
    this.viewer.attach(
      {
        on: (_event: string, listener: NonNullable<ActivityLog['upgrade']>) => (this.upgrade = listener),
        off: () => {},
      } as never,
      { path: `${mount}/ws` },
    )
  }

  start() {
    return this.viewer.start()
  }
  async close() {
    this.webhooks.close()
    await this.viewer.close()
  }

  private caller(request: IncomingMessage): Caller {
    return {
      ip: request.socket.remoteAddress ?? '',
      headers: request.headers,
      cookies: this.cookies(request.headers.cookie ?? ''),
    }
  }

  /** The account's stream; named so another account's cannot be guessed. */
  channel(owner: Owner) {
    const digest = createHmac('sha256', this.deployment.secret).update(`logs\0${owner.userId}`).digest('hex')
    return `outpost-${digest.slice(0, 32)}`
  }

  view(owner: Owner): LogView {
    const channel = this.channel(owner)
    this.viewer.streams!.registry.getOrCreate(channel)
    return { path: `${mount}/`, channel }
  }

  record(owner: Owner, input: LogInput, exceptWebhook: string | null = null) {
    const event: LogEvent = {
      id: randomUUID(),
      time: input.time ?? new Date().toISOString(),
      level: input.level ?? 'info',
      kind: input.kind,
      type: input.type,
      message: input.message,
      machine: input.machine ?? null,
      session: input.session ?? null,
      details: input.details ?? {},
    }
    this.viewer.streams!.append(this.channel(owner), [entry(event)])
    this.webhooks.publish(owner, event, exceptWebhook)
    return event
  }

  // Serving the viewer -----------------------------------------------------------------

  /** Headers for the viewer's pages: framed only by Outpost's own Logs page. */
  private headers(reply: FastifyReply, request: FastifyRequest) {
    const raw = reply.raw
    raw.setHeader('X-Content-Type-Options', 'nosniff')
    raw.setHeader('Referrer-Policy', 'no-referrer')
    raw.setHeader('X-Frame-Options', 'SAMEORIGIN')
    if (this.deployment.mode === 'hosted') {
      const origin = this.deployment.origin(request)
      raw.setHeader(
        'Content-Security-Policy',
        `default-src 'self'; connect-src 'self' ${origin.replace(/^http/, 'ws')}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'`,
      )
    } else raw.setHeader('Content-Security-Policy', "frame-ancestors 'self'")
  }

  /** HTTP requests under /log-viewer, after the app's own checks. */
  serve(request: FastifyRequest, reply: FastifyReply) {
    try {
      this.deployment.owner(request)
    } catch {
      return reply.code(401).send({ message: 'Sign in to continue.' })
    }
    const path = request.raw.url ?? '/'
    if (path === mount || path.startsWith(`${mount}?`)) return reply.redirect(`${mount}/${path.slice(mount.length)}`)
    reply.hijack()
    this.headers(reply, request)
    request.raw.url = path.slice(mount.length) || '/'
    this.viewer.handler(request.raw, reply.raw)
  }

  /** Whether an upgrade is the viewer's; it is then handled here. */
  handlesUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== `${mount}/ws`) return false
    const caller = this.caller(request)
    let refusal: string | null = this.deployment.admits(caller) ? '403 Forbidden' : null
    if (!refusal)
      try {
        this.deployment.owner(caller)
      } catch {
        refusal = '401 Unauthorized'
      }
    if (refusal) socket.end(`HTTP/1.1 ${refusal}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    else this.upgrade?.(request, socket, head)
    return true
  }
}

export const logViewerMount = mount
