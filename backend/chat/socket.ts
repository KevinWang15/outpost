import { Ajv } from 'ajv'
import type { FastifyRequest } from 'fastify'
import { WebSocket } from 'ws'
import type * as acp from '@agentclientprotocol/sdk'
import {
  chatClientMessage,
  chatProtocol,
  sessionKey,
  type ChatClientMessage,
  type ChatServerMessage,
  type SessionRef,
} from '../../shared/chatApi'
import { sessionCreationOptions } from '../../shared/sessionCreation'
import type { Owner } from '../deployment'
import { AppError } from '../errors'
import type { Services } from '../services'
import { createSession, inspectTargetSoftware } from '../session-actions'
import type { ChatClient, ChatHub } from './hub'
import type { LinkEvent } from './links'
import type { ChatTokens } from './tokens'

const ajv = new Ajv({
  allErrors: false,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  strict: false,
})
const validMessage = ajv.compile<ChatClientMessage>(chatClientMessage)
/** One chat page's socket. */
class Connection implements ChatClient {
  private subscriptions = new Map<string, () => void>()
  private window = { messages: 0, until: 0 }
  private closed = false
  private account: Awaited<ReturnType<ChatHub['attach']>>['account'] | null = null

  constructor(
    readonly owner: Owner,
    private socket: WebSocket,
    private server: ChatServer,
  ) {}

  send(message: ChatServerMessage) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return
    // A page that stops reading resynchronizes on reconnect instead of growing memory.
    if (this.socket.bufferedAmount > 32 * 1024 * 1024) return this.close('This page fell behind. Reconnecting…')
    this.socket.send(JSON.stringify(message))
  }

  close(message: string) {
    if (this.closed) return
    this.send({ type: 'closed', message })
    this.closed = true
    this.socket.close(1000)
    this.finish()
  }

  private finish() {
    this.closed = true
    for (const unsubscribe of this.subscriptions.values()) unsubscribe()
    this.subscriptions.clear()
    if (this.account) this.server.hub.detach(this.account, this)
    this.server.forget(this)
  }

  async start() {
    const queue: Buffer[] = []
    let ready = false
    this.socket.on('message', (data: Buffer, binary: boolean) => {
      if (binary) return this.socket.close(1008, 'Unexpected binary message')
      if (ready) void this.receive(data)
      else if (queue.length < 64) queue.push(data)
    })
    this.socket.on('close', () => this.finish())
    this.socket.on('error', () => this.socket.terminate())
    const attached = await this.server.hub.attach(this)
    this.account = attached.account
    if (this.closed) return this.server.hub.detach(attached.account, this)
    this.send({
      type: 'hello',
      protocol: chatProtocol,
      token: this.server.tokens.resume(this.owner),
      ...attached.hello,
    })
    this.send({ type: 'sessions', ...attached.sessions })
    ready = true
    for (const data of queue.splice(0)) await this.receive(data)
  }

  private async receive(data: Buffer) {
    const now = Date.now()
    if (this.window.until <= now) this.window = { messages: 0, until: now + 1000 }
    if (++this.window.messages > 100) return this.socket.close(1008, 'Message rate exceeded')
    let message: unknown
    try {
      message = JSON.parse(data.toString('utf8'))
    } catch {
      return this.socket.close(1008, 'Invalid chat message')
    }
    if (!validMessage(message)) return this.socket.close(1008, 'Invalid chat message')
    const id = 'id' in message ? message.id : null
    try {
      const result = await this.handle(message)
      if (id)
        this.send({
          type: 'result',
          id,
          ok: result.ok,
          ...(result.message ? { message: result.message } : {}),
          ...(result.data !== undefined ? { data: result.data } : {}),
        })
    } catch (error) {
      if (id) this.send({ type: 'result', id, ok: false, message: (error as Error).message })
    }
  }

  private open(ref: SessionRef, start: boolean) {
    return this.server.hub.link(this.owner, ref).then(link => {
      const key = sessionKey(ref)
      this.subscriptions.get(key)?.()
      const forward = (event: LinkEvent) => {
        if (event.type === 'journal')
          this.send({ type: 'journal', ...ref, info: link.info, journal: link.journal.snapshot() })
        else if (event.type === 'entry') this.send({ type: 'entry', ...ref, entry: event.entry })
        else if (event.type === 'info') this.send({ type: 'info', ...ref, info: event.info })
        else this.send({ type: 'link', ...ref, state: event.state, message: event.message })
      }
      this.subscriptions.set(key, link.subscribe(forward))
      link.ensure(start)
      this.send({ type: 'link', ...ref, state: link.state, message: link.message })
      if (link.state === 'live') forward({ type: 'journal' })
      return link
    })
  }

  private async existing(ref: SessionRef) {
    const link = await this.server.hub.link(this.owner, ref)
    if (link.state !== 'live') throw new AppError(link.message ?? 'The chat is not running. Open it to start it.', 409)
    return link
  }

  private async handle(message: ChatClientMessage): Promise<{ ok: boolean; message?: string; data?: unknown }> {
    const hub = this.server.hub
    const ref = 'sessionId' in message ? { targetId: message.targetId, sessionId: message.sessionId } : null
    switch (message.type) {
      case 'open':
        await this.open(ref!, message.start)
        return { ok: true }
      case 'close':
        this.subscriptions.get(sessionKey(ref!))?.()
        this.subscriptions.delete(sessionKey(ref!))
        return { ok: true }
      case 'prompt': {
        const prompt: acp.ContentBlock[] = message.text.trim() ? [{ type: 'text', text: message.text }] : []
        if (!prompt.length && !message.files.length) throw new AppError('Write a message first.', 400)
        const link = await hub.link(this.owner, ref!)
        link.ensure(true)
        const result = await link.request(
          { type: 'prompt', key: message.key, origin: { kind: 'user' }, prompt, files: message.files },
          180_000,
        )
        return result.unknown
          ? { ok: false, message: 'The chat did not confirm this message. If it does not appear above, send it again.' }
          : result
      }
      case 'cancel':
        return (await this.existing(ref!)).request({ type: 'cancel' })
      case 'unqueue':
        return (await this.existing(ref!)).request({ type: 'unqueue', turn: message.turn })
      case 'permission':
        return (await this.existing(ref!)).request({
          type: 'permission',
          request: message.request,
          optionId: message.optionId,
        })
      case 'config':
        return (await this.existing(ref!)).request(
          { type: 'config', configId: message.configId, value: message.value },
          60_000,
        )
      case 'mode':
        return (await this.existing(ref!)).request({ type: 'mode', modeId: message.modeId }, 60_000)
      case 'seen': {
        const link = await hub.link(this.owner, ref!)
        if (link.state === 'live') void link.request({ type: 'seen', completionId: message.completionId })
        return { ok: true }
      }
      case 'stop': {
        const context = await this.server.services.resolve(this.owner, ref!.targetId)
        await this.server.services.sessions.terminate(context, ref!.sessionId)
        await hub.refreshFor(this.owner)
        return { ok: true }
      }
      case 'instructions': {
        // Instructions are session configuration; they apply when the chat next starts.
        const context = await this.server.services.resolve(this.owner, ref!.targetId)
        const session = await this.server.services.sessions.get(context, ref!.sessionId)
        await this.server.services.sessions.update(context, ref!.sessionId, {
          revision: session.config.revision,
          instructions: message.instructions,
        })
        await hub.refreshFor(this.owner)
        return { ok: true }
      }
      case 'channel-save':
        return { ok: true, data: await hub.saveChannel(this.owner, message.channel) }
      case 'channel-delete':
        await hub.deleteChannel(this.owner, message.channelId)
        return { ok: true }
      case 'channel-history':
        return { ok: true, data: await hub.history(this.owner, message.channelId, message.before) }
      case 'channel-post':
        return {
          ok: true,
          data: await hub.post(this.owner, message.channelId, message.key, message.text, message.files),
        }
      case 'channel-read':
        await hub.markRead(this.owner, message.channelId)
        return { ok: true }
      case 'schedule-save':
        return { ok: true, data: await hub.saveSchedule(this.owner, message.schedule) }
      case 'schedule-delete':
        await hub.deleteSchedule(this.owner, message.scheduleId)
        return { ok: true }
      case 'schedule-run':
        await hub.runSchedule(this.owner, message.scheduleId)
        return { ok: true }
      case 'refresh':
        await hub.refreshFor(this.owner)
        return { ok: true }
      case 'session-options': {
        const context = await this.server.services.resolve(this.owner, message.targetId)
        const report = await inspectTargetSoftware(this.server.services, context, AbortSignal.timeout(60_000))
        return { ok: true, data: sessionCreationOptions(context.target, report.software) }
      }
      case 'directories': {
        const context = await this.server.services.resolve(this.owner, message.targetId)
        return {
          ok: true,
          data: await this.server.services.sessions.directories(context, message.path, AbortSignal.timeout(30_000)),
        }
      }
      case 'session-create': {
        const context = await this.server.services.resolve(this.owner, message.targetId)
        const session = await createSession(this.server.services, context, message.input, message.requestId)
        await hub.refreshFor(this.owner)
        return { ok: true, data: { targetId: context.target.id, sessionId: session.id } }
      }
      default:
        throw new AppError('Unknown chat request.', 400)
    }
  }
}

export class ChatServer {
  private connections = new Set<Connection>()
  private sweep: NodeJS.Timeout

  constructor(
    readonly hub: ChatHub,
    readonly tokens: ChatTokens,
    readonly services: Services,
  ) {
    this.sweep = setInterval(() => {
      for (const connection of this.connections)
        if (!services.active(connection.owner)) connection.close('Sign-in ended. Sign in again to continue.')
    }, 5000)
    this.sweep.unref()
  }

  forget(connection: Connection) {
    this.connections.delete(connection)
  }

  /** Browser pages authenticate with their login cookie; Outpost Desktop with a ticket. */
  async accept(socket: WebSocket, request: FastifyRequest<{ Querystring: { ticket?: string; protocol?: string } }>) {
    const reject = (message: string) => {
      socket.send(JSON.stringify({ type: 'closed', message } satisfies ChatServerMessage))
      socket.close(1000)
    }
    if (request.query.protocol !== String(chatProtocol)) return reject('Outpost was updated. Reload this page.')
    let owner: Owner | null = null
    try {
      owner = request.query.ticket ? this.tokens.redeem(request.query.ticket) : this.services.deployment.owner(request)
    } catch {
      owner = null
    }
    if (!owner || !this.services.active(owner)) return reject('Sign in to continue.')
    if ([...this.connections].filter(item => item.owner.userId === owner.userId).length >= 16)
      return reject('Too many open chat pages. Close one and try again.')
    const connection = new Connection(owner, socket, this)
    this.connections.add(connection)
    try {
      await connection.start()
    } catch (error) {
      connection.close((error as Error).message)
    }
  }

  close() {
    clearInterval(this.sweep)
    for (const connection of this.connections) connection.close('Outpost is restarting. Reconnecting…')
  }
}
