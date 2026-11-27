import { randomUUID } from 'node:crypto'
import {
  chatLimits,
  sessionKey,
  type ChannelMessage,
  type ChatSession,
  type Delivery,
  type DeliverySource,
  type SessionRef,
} from '../../shared/chatApi'
import { mentions } from '../../shared/chatMentions'
import type { ChannelManager } from './channels'
import { broadcast, findSession, linkKey, notStopped, now, type Account, type HubRuntime } from './context'
import type { DeliveryManager } from './deliveries'
import { replyPrompt, sessionPrompt, summary } from './prompts'

export class AgentTools {
  /** Agents' calls that send messages or posts, per session: at most this many a minute. */
  private sends = new Map<string, number[]>()

  constructor(
    private hub: HubRuntime,
    private deliveries: DeliveryManager,
    private channels: ChannelManager,
  ) {}

  private allowSend(ref: SessionRef) {
    const cutoff = Date.now() - 60_000
    for (const [key, times] of this.sends) {
      const kept = times.filter(at => at > cutoff)
      if (kept.length) this.sends.set(key, kept)
      else this.sends.delete(key)
    }
    const key = sessionKey(ref)
    const recent = this.sends.get(key) ?? []
    if (recent.length >= chatLimits.sendsPerMinute) return false
    this.sends.set(key, [...recent, Date.now()])
    return true
  }

  /** The prompt origin of the turn a session is running now, if any. */
  private runningOrigin(account: Account, ref: SessionRef) {
    const entries = this.hub.links.get(linkKey(account.userId, ref))?.journal.entries ?? []
    const ended = new Set(entries.flatMap(entry => (entry.kind === 'ended' ? [entry.turn] : [])))
    const started = [...entries]
      .reverse()
      .find(
        (entry): entry is Extract<typeof entry, { kind: 'started' }> =>
          entry.kind === 'started' && !ended.has(entry.turn),
      )
    const queued = started && entries.find(entry => entry.kind === 'queued' && entry.turn === started.turn)
    if (queued?.kind === 'queued') return queued.origin
    // A terminal's turn came from the message typed into it, if any.
    return (
      account.store.deliveries.deliveries.find(
        item => item.via === 'terminal' && item.state === 'running' && sessionKey(item) === sessionKey(ref),
      )?.origin ?? null
    )
  }

  /** A session by @handle or name, for an agent's tool call. */
  private named(account: Account, wanted: unknown): ChatSession {
    if (typeof wanted !== 'string' || !wanted.trim()) throw new Error('Name a session.')
    const key = wanted.trim().replace(/^@/, '').toLowerCase()
    const matches = account.view.filter(item => item.handle === key || item.name.toLowerCase() === key)
    if (!matches.length) throw new Error(`No session named ${wanted}. Call list_sessions to see the names.`)
    if (matches.length > 1)
      throw new Error(
        `Several sessions are named ${wanted}; use one of: ${matches.map(item => `@${item.handle}`).join(', ')}.`,
      )
    return matches[0]
  }

  async sessionReply(
    account: Account,
    delivery: Delivery,
    source: Extract<DeliverySource, { kind: 'session' }>,
    stop: { stopReason: string; error: string | null } | null,
    text: string,
  ) {
    const member = findSession(account, delivery)
    const handle = member?.handle ?? 'session'
    const body =
      stop?.stopReason === 'end_turn' || stop?.stopReason === 'max_tokens'
        ? text
        : `(@${handle} ${stop?.stopReason === 'cancelled' ? 'stopped' : 'failed'} without replying${stop?.error ? `: ${stop.error}` : ''}.)`
    const reply = this.deliveries.create(
      source.from,
      {
        kind: 'session',
        threadId: source.threadId,
        hop: source.hop,
        from: { targetId: delivery.targetId, sessionId: delivery.sessionId, name: member?.name ?? handle, handle },
        reply: true,
      },
      replyPrompt(handle, body),
      {
        kind: 'reply',
        from: { targetId: delivery.targetId, sessionId: delivery.sessionId, name: member?.name ?? handle },
        threadId: source.threadId,
        summary: summary(body),
      },
    )
    await this.deliveries.add(account, reply)
    await this.deliveries
      .send(account, reply)
      .catch(error => this.deliveries.fail(account, reply, (error as Error).message))
  }

  /** Outpost tools called by a session's agent (machine/mcp.ts). */
  async call(account: Account, ref: SessionRef, tool: string, args: Record<string, unknown>) {
    await this.hub.fresh(account)
    const sender = findSession(account, ref)
    const self = (item: SessionRef) => item.targetId === ref.targetId && item.sessionId === ref.sessionId

    if (tool === 'list_machines')
      return {
        machines: account.targets.map(target => ({
          machine: target.name,
          sessions: account.view.filter(item => item.targetId === target.id).length,
          reachable: target.error === null,
          ...(target.error ? { problem: target.error } : {}),
        })),
      }

    if (tool === 'list_sessions')
      return {
        sessions: account.view
          .filter(item => !self({ targetId: item.targetId, sessionId: item.id }))
          .map(item => ({
            handle: `@${item.handle}`,
            name: item.name,
            tool: item.tool,
            machine: item.target,
            directory: item.rootDir,
            activity: item.activity.state,
            runningIn: item.driver,
          })),
        channels: account.store.channels.channels
          .filter(channel => channel.members.some(member => self(member)))
          .map(channel => `#${channel.name}`),
      }

    if (tool === 'message_session') {
      const input = args as { session?: unknown; message?: unknown }
      if (typeof input.message !== 'string' || !input.message.trim()) throw new Error('Write a message.')
      if (input.message.length > chatLimits.text) throw new Error('The message is too long.')
      const recipient = this.named(account, input.session)
      if (self({ targetId: recipient.targetId, sessionId: recipient.id })) throw new Error('That is this session.')
      if (!this.allowSend(ref)) throw new Error('Too many messages this minute. Wait, or report back to the user.')
      const origin = this.runningOrigin(account, ref)
      const thread = origin && (origin.kind === 'session' || origin.kind === 'reply') ? origin.threadId : randomUUID()
      const hops = await account.store.change(['threads'], () => {
        const next = (account.store.threads.threads[thread]?.hops ?? 0) + 1
        if (next > chatLimits.threadHops)
          throw new Error('This conversation between sessions reached its limit. Report back to the user instead.')
        account.store.threads.threads[thread] = { hops: next, at: account.store.threads.threads[thread]?.at ?? now() }
        return next
      })
      const from = {
        targetId: ref.targetId,
        sessionId: ref.sessionId,
        name: sender?.name ?? 'session',
        handle: sender?.handle ?? 'session',
      }
      const delivery = this.deliveries.create(
        { targetId: recipient.targetId, sessionId: recipient.id },
        { kind: 'session', threadId: thread, hop: hops, from, reply: false },
        sessionPrompt(from.handle, input.message),
        {
          kind: 'session',
          from: { targetId: from.targetId, sessionId: from.sessionId, name: from.name },
          threadId: thread,
          summary: summary(input.message),
        },
      )
      await this.deliveries.add(account, delivery)
      void this.deliveries
        .send(account, delivery)
        .catch(error => this.deliveries.fail(account, delivery, (error as Error).message))
      return {
        sent: true,
        to: `@${recipient.handle}`,
        note:
          recipient.driver === 'terminal' && recipient.delivery === 'manual'
            ? 'That session takes messages when its user delivers them. The reply arrives here as a new message.'
            : 'The reply arrives here later as a new message.',
      }
    }

    if (tool === 'post_to_channel') {
      const input = args as { channel?: unknown; message?: unknown }
      if (typeof input.message !== 'string' || !input.message.trim()) throw new Error('Write a message.')
      if (input.message.length > chatLimits.text) throw new Error('The message is too long.')
      const name = typeof input.channel === 'string' ? input.channel.trim().replace(/^#/, '').toLowerCase() : ''
      const channel = account.store.channels.channels.find(
        item => item.name.toLowerCase() === name && item.members.some(member => self(member)),
      )
      const member = channel?.members.find(item => self(item))
      if (!channel || !member)
        throw new Error(`This session is not in #${name || '?'}. list_sessions shows its channels.`)
      if (!this.allowSend(ref)) throw new Error('Too many messages this minute. Wait, or report back to the user.')
      // A post during a channel turn continues that conversation, within its limits.
      const origin = this.runningOrigin(account, ref)
      const running = account.store.deliveries.deliveries.find(
        item =>
          notStopped(item) &&
          item.source.kind === 'channel' &&
          item.source.channelId === channel.id &&
          sessionKey(item) === sessionKey(ref),
      )
      const source = running?.source.kind === 'channel' ? running.source : null
      const id = randomUUID()
      const known = channel.members.map(item => item.handle)
      const found = mentions(input.message, known)
      const message: ChannelMessage = {
        id,
        channelId: channel.id,
        at: now(),
        author: { kind: 'session', ...member },
        text: input.message.trim(),
        mentions: found.everyone ? known : found.handles,
        root: source?.root ?? id,
        hop: source ? source.hop + 1 : origin ? 1 : 0,
        turn: null,
        key: null,
        files: [],
      }
      await account.store.append(message)
      broadcast(account, { type: 'message', message })
      await this.channels.route(account, channel, message, member)
      return { posted: true, channel: `#${channel.name}` }
    }

    if (tool === 'fetch_file') {
      const input = args as { session?: unknown; file?: unknown }
      const owner = this.named(account, input.session)
      if (typeof input.file !== 'string' || !input.file.trim()) throw new Error('Name the file or give its ID.')
      const signal = AbortSignal.timeout(120_000)
      const source = await this.hub.dependencies.resolve(account.owner, owner.targetId)
      const files = await this.hub.dependencies.files.list(source, owner.id, signal)
      const wanted = input.file.trim()
      const file = files.find(item => item.id === wanted) ?? [...files].reverse().find(item => item.name === wanted)
      if (!file)
        throw new Error(
          `@${owner.handle} has no file ${wanted}. Its files: ${files.map(item => item.name).join(', ') || 'none'}.`,
        )
      const { bytes } = await this.hub.dependencies.files.read(source, owner.id, file.id, signal)
      const destination = await this.hub.dependencies.resolve(account.owner, ref.targetId)
      const stored = await this.hub.dependencies.files.receive(destination, ref.sessionId, file.name, bytes, signal)
      return { stored: true, file: stored, from: `@${owner.handle}` }
    }

    throw new Error('Unknown Outpost tool.')
  }
}
