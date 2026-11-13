import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  chatLimits,
  sessionKey,
  type Channel,
  type ChannelInput,
  type ChannelMessage,
  type ChannelView,
  type ChatServerMessage,
  type ChatSession,
  type ChatTarget,
  type Delivery,
  type DeliverySource,
  type Schedule,
  type ScheduleInput,
  type SessionRef,
} from '../../shared/chatApi'
import { chatHost, type ChatOrigin } from '../../shared/chatHost'
import { replyText, turnFiles } from '../../shared/chatTranscript'
import type { SessionFile } from '../../shared/sessionFiles'
import { handles, mentions } from '../../shared/chatMentions'
import { cronMatches, parseCron, validTimeZone, zonedParts } from '../../shared/cron'
import type { HarnessId } from '../../shared/harnesses'
import type { Session } from '../../shared/model'
import type { Deployment, Owner } from '../deployment'
import { AppError } from '../errors'
import type { SessionFileClient } from '../sessionFiles'
import type { SessionClient, TargetContext, TerminalDelivery } from '../sessions'
import { ChannelFiles } from './files'
import { ChatLink, type ChatConnector, type LinkEvent } from './links'
import { channelPrompt, replyPrompt, schedulePrompt, sessionPrompt, summary } from './prompts'
import { ChatStore } from './store'
import { writeJsonFile } from '../../shared/node/jsonFile'

export interface ChatClient {
  owner: Owner
  send(message: ChatServerMessage): void
}

interface Account {
  userId: string
  /** Any current login of the account; background work resolves targets with it. */
  owner: Owner
  store: ChatStore
  /** Files attached to the user's channel posts. */
  files: ChannelFiles
  clients: Set<ChatClient>
  sessions: Map<string, Session[]>
  errors: Map<string, string>
  machines: Map<string, { name: string; tools: HarnessId[] }>
  view: ChatSession[]
  targets: ChatTarget[]
  refreshedAt: number
  refreshing: Promise<void> | null
  viewKey: string
  poller: NodeJS.Timeout | null
  /** Posts being written, by key; stored posts carry their key. */
  posts: Map<string, string>
}

interface Dependencies {
  deployment: Deployment
  resolve(owner: Owner, targetId: string): Promise<TargetContext>
  list(context: TargetContext, signal?: AbortSignal): Promise<Session[]>
  /** Session files on targets, to give channel members the files a delivery carries. */
  files: Pick<SessionFileClient, 'list' | 'read' | 'receive'>
  /** Sessions running in a terminal take messages through their terminal service. */
  terminals: Pick<SessionClient, 'deliver' | 'deliveries'>
  connect: ChatConnector
  /** How long a target may take to accept a composed prompt. */
  promptMs?: number
  /** How long a connected chat may stay silent (tests). */
  probeMs?: number
  /** How often messages typed into terminals are checked on (tests). */
  terminalPollMs?: number
}

const pollMs = 15_000
const staleMs = 60_000
const notStopped = (delivery: Delivery) => delivery.state !== 'done' && delivery.state !== 'failed'
const now = () => new Date().toISOString()
/** The key a delivery's prompt carries; the chat host dedupes by it. */
const promptKey = (delivery: Delivery) => delivery.id.replace(/-/g, '')

/** Chat across all of an owner's targets: session lists, links to chat hosts,
 * channel routing, session-to-session messages and schedules. */
export class ChatHub {
  private accounts = new Map<string, Promise<Account>>()
  private links = new Map<string, ChatLink>()
  private finishing = new Set<string>()
  /** Deliveries with a prompt request in flight. */
  private sending = new Set<string>()
  private ticker: NodeJS.Timeout | null = null
  private terminalTimer: NodeJS.Timeout | null = null
  private polling = false
  private stopped = false

  constructor(private dependencies: Dependencies) {}

  // Accounts -------------------------------------------------------------------------

  private get ownersPath() {
    return join(this.dependencies.deployment.directory, 'chat-owners.json')
  }

  private async rememberOwner(userId: string) {
    let owners: string[] = []
    try {
      owners = JSON.parse(await readFile(this.ownersPath, 'utf8')).owners ?? []
    } catch {
      /* A missing or unreadable index lists nobody. */
    }
    if (owners.includes(userId)) return
    owners.push(userId)
    await writeJsonFile(this.ownersPath, { version: 1, owners })
  }

  private account(owner: Owner): Promise<Account> {
    let account = this.accounts.get(owner.userId)
    if (!account) {
      account = (async () => {
        const workspace = this.dependencies.deployment.workspace(owner)
        const store = new ChatStore(join(workspace.directory, 'chat'))
        await store.load()
        return {
          userId: owner.userId,
          owner,
          store,
          files: new ChannelFiles(join(workspace.directory, 'chat', 'files')),
          clients: new Set(),
          sessions: new Map(),
          errors: new Map(),
          machines: new Map(),
          view: [],
          targets: [],
          refreshedAt: 0,
          refreshing: null,
          viewKey: '',
          poller: null,
          posts: new Map(),
        }
      })()
      account.catch(() => this.accounts.delete(owner.userId))
      this.accounts.set(owner.userId, account)
    }
    return account
  }

  /** Recover in-flight work and start schedules (server start). */
  async start() {
    let owners: string[] = []
    try {
      owners = JSON.parse(await readFile(this.ownersPath, 'utf8')).owners ?? []
    } catch {
      /* No chat state yet. */
    }
    for (const userId of owners) {
      if (!this.dependencies.deployment.account(userId)) continue
      try {
        const account = await this.account({ userId, loginId: 'background' })
        void this.recover(account)
        // Agents that were working may call Outpost's tools; reconnect to answer them.
        void this.refresh(account)
      } catch {
        // A store with an invalid schema stays untouched; its owner sees the error.
      }
    }
    this.ticker = setInterval(() => void this.tick(), 20_000)
    this.ticker.unref()
  }

  /** Stop server-side work; chat hosts on targets keep running. */
  close() {
    this.stopped = true
    if (this.ticker) clearInterval(this.ticker)
    if (this.terminalTimer) clearInterval(this.terminalTimer)
    for (const link of [...this.links.values()]) link.dispose()
    for (const pending of this.accounts.values())
      void pending.then(
        account => account.poller && clearInterval(account.poller),
        () => {},
      )
  }

  async attach(client: ChatClient) {
    const account = await this.account(client.owner)
    account.owner = client.owner
    account.clients.add(client)
    await this.rememberOwner(account.userId)
    if (!account.poller) {
      account.poller = setInterval(() => void this.refresh(account), pollMs)
      account.poller.unref()
    }
    void this.refresh(account)
    return {
      account,
      hello: {
        channels: await Promise.all(account.store.channels.channels.map(channel => this.channelView(account, channel))),
        schedules: account.store.schedules.schedules,
        deliveries: account.store.deliveries.deliveries.filter(notStopped),
      },
      sessions: { sessions: account.view, targets: account.targets },
    }
  }

  detach(account: Account, client: ChatClient) {
    account.clients.delete(client)
    if (!account.clients.size && account.poller) {
      clearInterval(account.poller)
      account.poller = null
    }
  }

  private broadcast(account: Account, message: ChatServerMessage) {
    for (const client of account.clients) client.send(message)
  }

  // Session lists ----------------------------------------------------------------------

  refresh(account: Account): Promise<void> {
    account.refreshing ??= (async () => {
      try {
        const targets = await this.dependencies.deployment.workspace(account.owner).list()
        account.machines = new Map(targets.map(target => [target.id, { name: target.name, tools: target.tools }]))
        await Promise.all(
          targets.map(async target => {
            try {
              const context = await this.dependencies.resolve(account.owner, target.id)
              account.sessions.set(target.id, await this.dependencies.list(context, AbortSignal.timeout(45_000)))
              account.errors.delete(target.id)
            } catch (error) {
              account.errors.set(target.id, (error as Error).message)
            }
          }),
        )
        for (const id of account.sessions.keys()) if (!account.machines.has(id)) account.sessions.delete(id)
        account.refreshedAt = Date.now()
        this.rebuild(account)
        for (const [targetId, sessions] of account.sessions)
          for (const session of sessions)
            if (session.driver === 'chat' && ['working', 'waiting'].includes(session.activity.state))
              void this.link(account.owner, { targetId, sessionId: session.id }).then(
                link => link.ensure(false),
                () => {},
              )
      } finally {
        account.refreshing = null
      }
    })()
    return account.refreshing
  }

  private async fresh(account: Account) {
    if (Date.now() - account.refreshedAt > staleMs) await this.refresh(account)
  }

  private rebuild(account: Account) {
    const items = [...account.sessions.entries()].flatMap(([targetId, sessions]) =>
      sessions.map(session => ({ targetId, target: account.machines.get(targetId)?.name ?? targetId, session })),
    )
    const named = handles(items.map(item => ({ ...item, sessionId: item.session.id, name: item.session.name })))
    account.view = items.map(({ targetId, target, session }) => {
      const link = this.links.get(this.linkKey(account.userId, { targetId, sessionId: session.id }))
      const live = link?.state === 'live' && link.info
      return {
        ...session,
        ...(live ? { activity: link.info!.activity, driver: 'chat' as const, status: 'attached' as const } : {}),
        targetId,
        target,
        handle: named.get(`${targetId}/${session.id}`)!,
      }
    })
    account.targets = [...account.machines].map(([id, machine]) => ({
      id,
      ...machine,
      error: account.errors.get(id) ?? null,
    }))
    const key = JSON.stringify([
      account.view.map(item => ({ ...item, activity: { ...item.activity, observedAt: null } })),
      account.targets,
    ])
    if (key === account.viewKey) return
    account.viewKey = key
    this.broadcast(account, { type: 'sessions', sessions: account.view, targets: account.targets })
  }

  private find(account: Account, ref: SessionRef) {
    return account.view.find(item => item.targetId === ref.targetId && item.id === ref.sessionId) ?? null
  }

  // Links -------------------------------------------------------------------------------

  private linkKey(userId: string, ref: SessionRef) {
    return `${userId}/${sessionKey(ref)}`
  }

  /** The shared link to a session's chat host; resolving the target checks ownership. */
  async link(owner: Owner, ref: SessionRef): Promise<ChatLink> {
    const account = await this.account(owner)
    const key = this.linkKey(account.userId, ref)
    const existing = this.links.get(key)
    if (existing) return existing
    const context = await this.dependencies.resolve(owner, ref.targetId)
    const raced = this.links.get(key)
    if (raced) return raced
    const link = new ChatLink(
      key,
      (start, events) => this.dependencies.connect(context, ref.sessionId, start, events),
      {
        changed: (from, event) => this.changed(account, ref, from, event),
        disposed: from => {
          if (this.links.get(key) === from) this.links.delete(key)
        },
      },
      this.dependencies.probeMs,
    )
    this.links.set(key, link)
    return link
  }

  private changed(account: Account, ref: SessionRef, link: ChatLink, event: LinkEvent) {
    if (event.type === 'entry') {
      const { entry } = event
      if (entry.kind === 'queued' && entry.key) {
        // The host accepted a prompt; its answer carries the same turn but may be lost.
        const delivery = account.store.deliveries.deliveries.find(
          item =>
            !item.turn && notStopped(item) && promptKey(item) === entry.key && sessionKey(item) === sessionKey(ref),
        )
        if (delivery) void this.adopt(account, delivery, link, entry.turn)
      }
      if (entry.kind === 'started' || entry.kind === 'ended') {
        const delivery = account.store.deliveries.deliveries.find(
          item =>
            item.targetId === ref.targetId &&
            item.sessionId === ref.sessionId &&
            item.turn === entry.turn &&
            notStopped(item),
        )
        if (delivery && entry.kind === 'started') void this.update(account, delivery, { state: 'running' })
        if (delivery && entry.kind === 'ended') void this.finished(account, delivery, link)
      }
    } else if (event.type === 'journal') {
      void this.reconcile(account, ref, link)
    } else if (event.type === 'info' || event.type === 'link') {
      this.rebuild(account)
      if (event.type === 'link' && (event.state === 'stopped' || event.state === 'unavailable')) {
        void this.linkEnded(account, ref, link, event.message)
        void this.refresh(account)
      }
    }
  }

  // Deliveries ------------------------------------------------------------------------------

  /** Changes apply at once, so journal events that follow see them; saving follows. */
  private async update(account: Account, delivery: Delivery, change: Partial<Delivery>) {
    Object.assign(delivery, change, { updatedAt: now() })
    this.broadcast(account, { type: 'delivery', delivery })
    await account.store.change(['deliveries'], () => {})
  }

  private async add(account: Account, delivery: Delivery) {
    await account.store.change(['deliveries'], () => {
      account.store.deliveries.deliveries.push(delivery)
    })
    this.broadcast(account, { type: 'delivery', delivery })
  }

  private delivery(
    ref: SessionRef,
    source: DeliverySource,
    prompt: string | null,
    origin: ChatOrigin | null,
  ): Delivery {
    const at = now()
    return {
      ...ref,
      id: randomUUID(),
      state: 'pending',
      turn: null,
      source,
      rerun: null,
      prompt,
      files: [],
      host: null,
      via: null,
      origin,
      error: null,
      createdAt: at,
      updatedAt: at,
    }
  }

  /** Queue a composed prompt in the member's chat. The prompt key dedupes resends
   * to the same host instance, so a resend after a lost answer cannot run twice. */
  private async send(account: Account, delivery: Delivery) {
    if (this.stopped || this.sending.has(delivery.id) || !notStopped(delivery)) return
    // A session running in a terminal gets it typed in; any other one in its chat.
    if (delivery.via === 'terminal' || (delivery.via === null && this.find(account, delivery)?.driver === 'terminal'))
      return this.sendTerminal(account, delivery)
    this.sending.add(delivery.id)
    try {
      const link = await this.link(account.owner, delivery)
      link.hold(delivery.id)
      link.ensure(true)
      const result = await link.request(
        {
          type: 'prompt',
          key: promptKey(delivery),
          origin: delivery.origin ?? { kind: 'user' },
          prompt: [{ type: 'text', text: delivery.prompt ?? '' }],
          files: delivery.files,
        },
        this.dependencies.promptMs ?? 180_000,
        instance => {
          if (delivery.host !== instance) void this.update(account, delivery, { state: 'sent', host: instance })
        },
      )
      // Unconfirmed: the journal's `queued` entry or the next reconnect settles it.
      if (this.stopped || result.unknown) return
      if (!result.ok)
        return this.failDelivery(account, delivery, result.message ?? 'The session did not accept the message.')
      const turn = (result.data as { turn?: string } | undefined)?.turn
      if (turn) await this.adopt(account, delivery, link, turn)
    } finally {
      this.sending.delete(delivery.id)
    }
  }

  /** Hand the message to the session's terminal service, which types it in when
   * the agent is idle and nobody is typing. The key makes a resend harmless. */
  private async sendTerminal(account: Account, delivery: Delivery) {
    this.sending.add(delivery.id)
    try {
      const context = await this.dependencies.resolve(account.owner, delivery.targetId)
      const progress = await this.dependencies.terminals.deliver(
        context,
        delivery.sessionId,
        promptKey(delivery),
        delivery.prompt ?? '',
      )
      if (delivery.via !== 'terminal') await this.update(account, delivery, { state: 'sent', via: 'terminal' })
      await this.progress(account, delivery, progress)
      this.watchTerminals()
    } catch (error) {
      await this.failDelivery(account, delivery, (error as Error).message)
    } finally {
      this.sending.delete(delivery.id)
    }
  }

  /** Check on messages typed into terminals until they are answered. */
  private watchTerminals() {
    if (this.terminalTimer || this.stopped) return
    this.terminalTimer = setInterval(() => void this.pollTerminals(), this.dependencies.terminalPollMs ?? 2000)
    this.terminalTimer.unref()
  }

  private async pollTerminals() {
    if (this.polling) return
    this.polling = true
    let active = 0
    try {
      for (const pending of this.accounts.values()) {
        const account = await pending.catch(() => null)
        if (!account) continue
        const bySession = new Map<string, Delivery[]>()
        for (const delivery of account.store.deliveries.deliveries)
          if (delivery.via === 'terminal' && notStopped(delivery) && !this.sending.has(delivery.id))
            bySession.set(sessionKey(delivery), [...(bySession.get(sessionKey(delivery)) ?? []), delivery])
        for (const deliveries of bySession.values()) {
          active += deliveries.length
          const [first] = deliveries
          try {
            const context = await this.dependencies.resolve(account.owner, first.targetId)
            const found = await this.dependencies.terminals.deliveries(
              context,
              first.sessionId,
              deliveries.map(promptKey),
            )
            for (const delivery of deliveries) {
              const progress = found.find(item => item.key === promptKey(delivery))
              if (progress) await this.progress(account, delivery, progress)
              else await this.failDelivery(account, delivery, 'The session no longer has this message.')
            }
          } catch (error) {
            // Unreachable for now: keep waiting. A session that left its terminal cannot answer.
            if (error instanceof AppError && error.statusCode === 409)
              for (const delivery of deliveries)
                await this.failDelivery(account, delivery, 'The session stopped before replying.')
          }
        }
      }
    } finally {
      this.polling = false
      if (!active && this.terminalTimer) {
        clearInterval(this.terminalTimer)
        this.terminalTimer = null
      }
    }
  }

  private async progress(account: Account, delivery: Delivery, progress: TerminalDelivery) {
    if (!notStopped(delivery)) return
    if (progress.state === 'typed' && delivery.state !== 'running')
      await this.update(account, delivery, { state: 'running' })
    else if (progress.state === 'done')
      await this.complete(account, delivery, { stopReason: 'end_turn', error: null }, progress.reply ?? '', [])
    else if (progress.state === 'failed')
      await this.failDelivery(account, delivery, progress.error ?? 'The session did not reply.')
  }

  /** The host accepted the delivery's prompt as `turn`. */
  private async adopt(account: Account, delivery: Delivery, link: ChatLink, turn: string) {
    if (!notStopped(delivery) || delivery.turn === turn) return
    const started = link.journal.entries.some(entry => entry.kind === 'started' && entry.turn === turn)
    await this.update(account, delivery, { state: started ? 'running' : 'sent', turn, prompt: null })
    // A quick turn may have ended before its id was known.
    if (link.journal.entries.some(entry => entry.kind === 'ended' && entry.turn === turn))
      await this.finished(account, delivery, link)
  }

  private async failDelivery(account: Account, delivery: Delivery, error: string) {
    if (this.stopped || !notStopped(delivery)) return
    this.links.get(this.linkKey(account.userId, delivery))?.release(delivery.id)
    await this.update(account, delivery, { state: 'failed', error, prompt: null })
    const member = this.find(account, delivery)
    const name = member ? `@${member.handle}` : 'The session'
    const { source } = delivery
    if (source.kind === 'channel')
      await this.notice(account, source.channelId, 'warning', `${name} could not reply: ${error}`, source.root)
    else if (source.kind === 'session' && !source.reply) {
      const sender = await this.link(account.owner, source.from).catch(() => null)
      sender?.ensure(false)
      await sender?.request({
        type: 'note',
        level: 'warning',
        text: `${name} could not receive your message: ${error}`,
      })
    } else if (source.kind === 'schedule') await this.ran(account, source.scheduleId, false, error)
  }

  private async finished(account: Account, delivery: Delivery, link: ChatLink) {
    if (!notStopped(delivery) || this.finishing.has(delivery.id) || !delivery.turn) return
    this.finishing.add(delivery.id)
    try {
      const ended = link.journal.entries.find(entry => entry.kind === 'ended' && entry.turn === delivery.turn)
      link.release(delivery.id)
      await this.complete(
        account,
        delivery,
        ended?.kind === 'ended' ? ended : null,
        replyText(link.journal.entries, delivery.turn),
        turnFiles(link.journal.entries, delivery.turn),
      )
    } finally {
      this.finishing.delete(delivery.id)
    }
  }

  /** The session's turn for this delivery ended: pass its reply on. */
  private async complete(
    account: Account,
    delivery: Delivery,
    stop: { stopReason: string; error: string | null } | null,
    text: string,
    files: SessionFile[],
  ) {
    if (!notStopped(delivery)) return
    await this.update(account, delivery, { state: 'done', error: stop?.error ?? null, prompt: null })
    const { source } = delivery
    if (source.kind === 'channel') await this.channelReply(account, delivery, source, stop, text, files)
    else if (source.kind === 'session' && !source.reply) await this.sessionReply(account, delivery, source, stop, text)
    else if (source.kind === 'schedule')
      await this.ran(account, source.scheduleId, stop?.stopReason === 'end_turn', stop?.error ?? null)
  }

  /** After a (re)connect: settle deliveries whose turns ended or vanished, and
   * resend unconfirmed prompts to the host that may have them. */
  private async reconcile(account: Account, ref: SessionRef, link: ChatLink) {
    const active = account.store.deliveries.deliveries.filter(
      item =>
        sessionKey(item) === sessionKey(ref) &&
        item.via !== 'terminal' &&
        (item.state === 'sent' || item.state === 'running') &&
        !this.sending.has(item.id),
    )
    for (const delivery of active) {
      const entries = link.journal.entries
      if (!delivery.turn) {
        const queued = entries.find(entry => entry.kind === 'queued' && entry.key === promptKey(delivery))
        if (queued?.kind === 'queued') await this.adopt(account, delivery, link, queued.turn)
        else if (delivery.host === link.instance) void this.send(account, delivery)
        else
          await this.failDelivery(
            account,
            delivery,
            'The session restarted before confirming the message; it may not have run.',
          )
      } else if (entries.some(entry => entry.kind === 'ended' && entry.turn === delivery.turn))
        await this.finished(account, delivery, link)
      else if (!link.journal.truncated && !entries.some(entry => 'turn' in entry && entry.turn === delivery.turn))
        await this.failDelivery(account, delivery, 'The session restarted before replying.')
    }
  }

  private async linkEnded(account: Account, ref: SessionRef, link: ChatLink, message: string | null) {
    const active = account.store.deliveries.deliveries.filter(
      item =>
        item.targetId === ref.targetId &&
        item.sessionId === ref.sessionId &&
        item.via !== 'terminal' &&
        (item.state === 'sent' || item.state === 'running'),
    )
    for (const delivery of active) {
      if (delivery.turn && link.journal.entries.some(entry => entry.kind === 'ended' && entry.turn === delivery.turn))
        await this.finished(account, delivery, link)
      else await this.failDelivery(account, delivery, message ?? 'The session stopped before replying.')
    }
  }

  private async recover(account: Account) {
    for (const delivery of account.store.deliveries.deliveries.filter(notStopped)) {
      try {
        if (delivery.state === 'pending') {
          if (delivery.prompt) await this.send(account, delivery)
          else if (delivery.source.kind === 'channel') await this.deliverChannel(account, delivery)
          else await this.failDelivery(account, delivery, 'Outpost restarted before sending this message.')
        } else if (delivery.via === 'terminal') this.watchTerminals()
        else {
          const link = await this.link(account.owner, delivery)
          link.hold(delivery.id)
          link.ensure(false)
        }
      } catch (error) {
        await this.failDelivery(account, delivery, (error as Error).message)
      }
    }
  }

  // Channels ---------------------------------------------------------------------------------

  private async channelView(account: Account, channel: Channel): Promise<ChannelView> {
    return {
      ...channel,
      lastAt: await account.store.lastAt(channel.id),
      readAt: account.store.channels.reads[channel.id] ?? null,
    }
  }

  async saveChannel(owner: Owner, input: ChannelInput) {
    const account = await this.account(owner)
    await this.fresh(account)
    const existing = input.id ? account.store.channels.channels.find(channel => channel.id === input.id) : undefined
    if (input.id && !existing) throw new AppError('Channel not found.', 404)
    if (account.store.channels.channels.some(channel => channel.name === input.name && channel.id !== input.id))
      throw new AppError(`#${input.name} already exists.`, 409)
    if (!existing && account.store.channels.channels.length >= chatLimits.channels)
      throw new AppError('Too many channels.', 409)
    const seen = new Set<string>()
    const members = input.members.flatMap(ref => {
      const key = sessionKey(ref)
      if (seen.has(key)) return []
      seen.add(key)
      const previous = existing?.members.find(member => sessionKey(member) === key)
      if (previous) return [previous]
      const session = this.find(account, ref)
      if (!session) throw new AppError('A member session was not found. Refresh and try again.', 404)
      return [{ ...ref, name: session.name, handle: session.handle }]
    })
    const used = new Set<string>()
    for (const member of members) {
      let handle = member.handle
      for (let suffix = 2; used.has(handle); suffix++) handle = `${member.handle}-${suffix}`
      member.handle = handle
      used.add(handle)
    }
    const channel: Channel = {
      id: existing?.id ?? randomUUID(),
      name: input.name,
      topic: input.topic.trim(),
      members,
      createdAt: existing?.createdAt ?? now(),
    }
    await account.store.change(['channels'], () => {
      const list = account.store.channels.channels
      const index = list.findIndex(item => item.id === channel.id)
      if (index >= 0) list[index] = channel
      else list.push(channel)
    })
    const view = await this.channelView(account, channel)
    this.broadcast(account, { type: 'channel', channel: view })
    return view
  }

  async deleteChannel(owner: Owner, channelId: string) {
    const account = await this.account(owner)
    if (!account.store.channels.channels.some(channel => channel.id === channelId))
      throw new AppError('Channel not found.', 404)
    await account.store.change(['channels', 'deliveries'], () => {
      const data = account.store.channels
      data.channels = data.channels.filter(channel => channel.id !== channelId)
      delete data.reads[channelId]
      delete data.cursors[channelId]
      for (const delivery of account.store.deliveries.deliveries)
        if (
          delivery.source.kind === 'channel' &&
          delivery.source.channelId === channelId &&
          delivery.state === 'pending'
        )
          Object.assign(delivery, { state: 'failed', error: 'The channel was deleted.', prompt: null })
    })
    await account.store.removeMessages(channelId)
    await account.files.removeChannel(channelId)
    this.broadcast(account, { type: 'channel-removed', channelId })
  }

  async history(owner: Owner, channelId: string, before: string | null) {
    const account = await this.account(owner)
    if (!account.store.channels.channels.some(channel => channel.id === channelId))
      throw new AppError('Channel not found.', 404)
    return account.store.page(channelId, before, chatLimits.page)
  }

  async markRead(owner: Owner, channelId: string) {
    const account = await this.account(owner)
    const channel = account.store.channels.channels.find(item => item.id === channelId)
    if (!channel) return
    await account.store.change(['channels'], () => {
      account.store.channels.reads[channelId] = now()
    })
    this.broadcast(account, { type: 'channel', channel: await this.channelView(account, channel) })
  }

  private async notice(
    account: Account,
    channelId: string,
    level: 'info' | 'warning' | 'error',
    text: string,
    root: string,
  ) {
    const message: ChannelMessage = {
      id: randomUUID(),
      channelId,
      at: now(),
      author: { kind: 'outpost', level },
      text,
      mentions: [],
      root,
      hop: 0,
      turn: null,
      key: null,
      files: [],
    }
    await account.store.append(message)
    this.broadcast(account, { type: 'message', message })
  }

  /** Post the user's message. A draft resent with the same key, also after a
   * restart, returns the first post. */
  async post(owner: Owner, channelId: string, key: string, text: string, files: string[] = []) {
    const account = await this.account(owner)
    const channel = account.store.channels.channels.find(item => item.id === channelId)
    if (!channel) throw new AppError('Channel not found.', 404)
    const body = text.trim()
    if (!body && !files.length) throw new AppError('Write a message first.', 400)
    const writing = account.posts.get(key)
    if (writing) return { messageId: writing, duplicate: true }
    const id = randomUUID()
    const known = channel.members.map(member => member.handle)
    const found = mentions(body, known)
    const message: ChannelMessage = {
      id,
      channelId,
      at: now(),
      author: { kind: 'user' },
      text: body,
      mentions: found.everyone ? known : found.handles,
      root: id,
      hop: 0,
      turn: null,
      key,
      files: [],
    }
    account.posts.set(key, id)
    try {
      const stored = (await account.store.recent(channelId)).find(item => item.key === key)
      if (stored) return { messageId: stored.id, duplicate: true }
      message.files = await account.files.commit(channelId, files)
      await account.store.append(message)
    } finally {
      account.posts.delete(key)
    }
    this.broadcast(account, { type: 'message', message })
    await this.markRead(owner, channelId)
    await this.route(account, channel, message, null)
    return { messageId: id, duplicate: false }
  }

  /** Deliver a channel message to the members it mentions. */
  private async route(account: Account, channel: Channel, message: ChannelMessage, author: SessionRef | null) {
    const targets = channel.members.filter(
      member => message.mentions.includes(member.handle) && !(author && sessionKey(author) === sessionKey(member)),
    )
    if (!targets.length) return
    const chain = account.store.deliveries.deliveries.filter(
      item => item.source.kind === 'channel' && item.source.root === message.root,
    ).length
    if (message.hop >= chatLimits.hops || chain + targets.length > chatLimits.chain) {
      await this.notice(
        account,
        channel.id,
        'info',
        'Outpost stopped passing the conversation between sessions here. Mention a member to continue.',
        message.root,
      )
      return
    }
    for (const member of targets) {
      const busy = account.store.deliveries.deliveries.find(
        item =>
          notStopped(item) &&
          item.source.kind === 'channel' &&
          item.source.channelId === channel.id &&
          sessionKey(item) === sessionKey(member),
      )
      if (busy) {
        await this.update(account, busy, { rerun: { root: message.root, hop: message.hop } })
        continue
      }
      const delivery = this.delivery(
        member,
        { kind: 'channel', channelId: channel.id, root: message.root, hop: message.hop, through: null },
        null,
        null,
      )
      await this.add(account, delivery)
      void this.deliverChannel(account, delivery).catch(error =>
        this.failDelivery(account, delivery, (error as Error).message),
      )
    }
  }

  /** Compose the member's prompt from the messages it has not received. */
  private async deliverChannel(account: Account, delivery: Delivery) {
    const source = delivery.source
    if (source.kind !== 'channel') return
    const channel = account.store.channels.channels.find(item => item.id === source.channelId)
    const member = channel?.members.find(item => sessionKey(item) === sessionKey(delivery))
    if (!channel || !member) return this.failDelivery(account, delivery, 'The channel or member was removed.')
    const cursor = account.store.channels.cursors[channel.id]?.[sessionKey(member)]
    const messages = await account.store.recent(channel.id)
    const start = cursor ? messages.findIndex(item => item.id === cursor) + 1 : 0
    const delta = messages
      .slice(start)
      .filter(item => !(item.author.kind === 'session' && sessionKey(item.author) === sessionKey(member)))
    if (!delta.length) return this.update(account, delivery, { state: 'done' })
    const trigger = [...delta].reverse().find(item => item.mentions.includes(member.handle)) ?? delta.at(-1)!
    const attached = await this.memberFiles(account, channel, member, delta)
    await this.update(account, delivery, {
      source: { ...source, through: delta.at(-1)!.id },
      prompt: channelPrompt(channel, member.handle, delta, attached.missing),
      files: attached.files,
      origin: {
        kind: 'channel',
        channelId: channel.id,
        channel: channel.name,
        messageId: trigger.id,
        summary: summary(trigger.text),
      },
    })
    await this.send(account, delivery)
  }

  /** Give the member the files in its new messages, newest first: each is
   * copied into the member's own session files, where its tools can read it. */
  private async memberFiles(account: Account, channel: Channel, member: SessionRef, messages: ChannelMessage[]) {
    const files: string[] = []
    const missing: string[] = []
    const signal = AbortSignal.timeout(120_000)
    const destination = await this.dependencies.resolve(account.owner, member.targetId)
    for (const message of [...messages].reverse())
      for (const file of message.files) {
        if (files.length >= chatHost.maxFiles) {
          missing.push(`${file.name} (more than ${chatHost.maxFiles} files)`)
          continue
        }
        try {
          const { author } = message
          const bytes =
            author.kind === 'session'
              ? (
                  await this.dependencies.files.read(
                    await this.dependencies.resolve(account.owner, author.targetId),
                    author.sessionId,
                    file.id,
                    signal,
                  )
                ).bytes
              : (await account.files.read(channel.id, file.id)).bytes
          files.push(
            (await this.dependencies.files.receive(destination, member.sessionId, file.name, bytes, signal)).id,
          )
        } catch (error) {
          missing.push(`${file.name} (${(error as Error).message})`)
        }
      }
    return { files, missing }
  }

  async stageFile(owner: Owner, channelId: string, name: string, data: Buffer) {
    const account = await this.account(owner)
    if (!account.store.channels.channels.some(channel => channel.id === channelId))
      throw new AppError('Channel not found.', 404)
    return account.files.stage(name, data)
  }

  async channelFiles(owner: Owner, channelId: string) {
    const account = await this.account(owner)
    if (!account.store.channels.channels.some(channel => channel.id === channelId))
      throw new AppError('Channel not found.', 404)
    return account.files.list(channelId)
  }

  async readChannelFile(owner: Owner, channelId: string, fileId: string) {
    const account = await this.account(owner)
    if (!account.store.channels.channels.some(channel => channel.id === channelId))
      throw new AppError('Channel not found.', 404)
    return account.files.read(channelId, fileId)
  }

  private async channelReply(
    account: Account,
    delivery: Delivery,
    source: Extract<DeliverySource, { kind: 'channel' }>,
    stop: { stopReason: string; error: string | null } | null,
    text: string,
    files: SessionFile[],
  ) {
    const channel = account.store.channels.channels.find(item => item.id === source.channelId)
    const member = channel?.members.find(item => sessionKey(item) === sessionKey(delivery))
    if (!channel || !member) return
    if (source.through)
      await account.store.change(['channels'], () => {
        const cursors = (account.store.channels.cursors[channel.id] ??= {})
        cursors[sessionKey(member)] = source.through!
      })
    if (stop?.stopReason === 'cancelled')
      await this.notice(account, channel.id, 'info', `@${member.handle} stopped without replying.`, source.root)
    else if (stop?.stopReason === 'error')
      await this.notice(
        account,
        channel.id,
        'warning',
        `@${member.handle} failed: ${stop.error ?? 'unknown error'}`,
        source.root,
      )
    else if (!text && !files.length)
      await this.notice(account, channel.id, 'info', `@${member.handle} finished without a reply.`, source.root)
    else {
      const known = channel.members.map(item => item.handle)
      const found = mentions(text, known)
      const message: ChannelMessage = {
        id: randomUUID(),
        channelId: channel.id,
        at: now(),
        author: {
          kind: 'session',
          targetId: member.targetId,
          sessionId: member.sessionId,
          name: member.name,
          handle: member.handle,
        },
        text,
        mentions: found.everyone ? known : found.handles,
        root: source.root,
        hop: source.hop + 1,
        turn: delivery.turn ? { targetId: member.targetId, sessionId: member.sessionId, turn: delivery.turn } : null,
        key: null,
        files,
      }
      await account.store.append(message)
      this.broadcast(account, { type: 'message', message })
      await this.route(account, channel, message, member)
    }
    if (delivery.rerun) {
      const next = this.delivery(
        member,
        { kind: 'channel', channelId: channel.id, ...delivery.rerun, through: null },
        null,
        null,
      )
      await this.add(account, next)
      void this.deliverChannel(account, next).catch(error => this.failDelivery(account, next, (error as Error).message))
    }
  }

  // Session messages ---------------------------------------------------------------------------

  private async sessionReply(
    account: Account,
    delivery: Delivery,
    source: Extract<DeliverySource, { kind: 'session' }>,
    stop: { stopReason: string; error: string | null } | null,
    text: string,
  ) {
    const member = this.find(account, delivery)
    const handle = member?.handle ?? 'session'
    const body =
      stop?.stopReason === 'end_turn' || stop?.stopReason === 'max_tokens'
        ? text
        : `(@${handle} ${stop?.stopReason === 'cancelled' ? 'stopped' : 'failed'} without replying${stop?.error ? `: ${stop.error}` : ''}.)`
    const reply = this.delivery(
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
    await this.add(account, reply)
    await this.send(account, reply).catch(error => this.failDelivery(account, reply, (error as Error).message))
  }

  /** The prompt origin of the turn a session is running now, if any. */
  private runningOrigin(account: Account, ref: SessionRef) {
    const entries = this.links.get(this.linkKey(account.userId, ref))?.journal.entries ?? []
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

  /** Agents' calls that send messages or posts, per session: at most this many a minute. */
  private sends = new Map<string, number[]>()
  private allowSend(ref: SessionRef) {
    const key = sessionKey(ref)
    const recent = (this.sends.get(key) ?? []).filter(at => Date.now() - at < 60_000)
    if (recent.length >= chatLimits.sendsPerMinute) return false
    this.sends.set(key, [...recent, Date.now()])
    return true
  }

  /** A session by @handle or name, for an agent's tool call. */
  private named(account: Account, wanted: unknown): { session: ChatSession } | { problem: string } {
    if (typeof wanted !== 'string' || !wanted.trim()) return { problem: 'Name a session.' }
    const key = wanted.trim().replace(/^@/, '').toLowerCase()
    const matches = account.view.filter(item => item.handle === key || item.name.toLowerCase() === key)
    if (!matches.length) return { problem: `No session named ${wanted}. Call list_sessions to see the names.` }
    if (matches.length > 1)
      return {
        problem: `Several sessions are named ${wanted}; use one of: ${matches.map(item => `@${item.handle}`).join(', ')}.`,
      }
    return { session: matches[0] }
  }

  /** Outpost tools called by a session's agent (machine/mcp.ts), arriving on
   * its machine's connection. */
  async agent(owner: Owner, ref: SessionRef, tool: string, args: Record<string, unknown>) {
    const result = await this.handleCall(await this.account(owner), ref, tool, args)
    if (!result.ok) throw new Error(result.message ?? 'Outpost did not accept this request.')
    return result.data
  }

  private async handleCall(
    account: Account,
    ref: SessionRef,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; message?: string; data?: unknown }> {
    const answer = (ok: boolean, text?: string, data?: unknown) => ({ ok, message: text, data })
    try {
      await this.fresh(account)
      const sender = this.find(account, ref)
      const self = (item: SessionRef) => item.targetId === ref.targetId && item.sessionId === ref.sessionId
      if (tool === 'list_machines')
        return answer(true, undefined, {
          machines: account.targets.map(target => ({
            machine: target.name,
            sessions: account.view.filter(item => item.targetId === target.id).length,
            reachable: target.error === null,
            ...(target.error ? { problem: target.error } : {}),
          })),
        })
      if (tool === 'list_sessions')
        return answer(true, undefined, {
          sessions: account.view
            .filter(item => !self({ targetId: item.targetId, sessionId: item.id }))
            .map(item => ({
              handle: `@${item.handle}`,
              name: item.name,
              ...(item.title && item.title !== item.name ? { title: item.title } : {}),
              tool: item.tool,
              machine: item.target,
              directory: item.rootDir,
              activity: item.activity.state,
              runningIn: item.driver,
            })),
          channels: account.store.channels.channels
            .filter(channel => channel.members.some(member => self(member)))
            .map(channel => `#${channel.name}`),
        })
      if (tool === 'message_session') {
        const input = args as { session?: unknown; message?: unknown }
        if (typeof input.message !== 'string' || !input.message.trim()) return answer(false, 'Write a message.')
        if (input.message.length > chatLimits.text) return answer(false, 'The message is too long.')
        const found = this.named(account, input.session)
        if ('problem' in found) return answer(false, found.problem)
        const recipient = found.session
        if (self({ targetId: recipient.targetId, sessionId: recipient.id }))
          return answer(false, 'That is this session.')
        if (!this.allowSend(ref))
          return answer(false, 'Too many messages this minute. Wait, or report back to the user.')
        const origin = this.runningOrigin(account, ref)
        const thread = origin && (origin.kind === 'session' || origin.kind === 'reply') ? origin.threadId : randomUUID()
        const hops = (account.store.threads.threads[thread]?.hops ?? 0) + 1
        if (hops > chatLimits.threadHops)
          return answer(false, 'This conversation between sessions reached its limit. Report back to the user instead.')
        await account.store.change(['threads'], () => {
          account.store.threads.threads[thread] = { hops, at: account.store.threads.threads[thread]?.at ?? now() }
        })
        const from = {
          targetId: ref.targetId,
          sessionId: ref.sessionId,
          name: sender?.name ?? 'session',
          handle: sender?.handle ?? 'session',
        }
        const delivery = this.delivery(
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
        await this.add(account, delivery)
        void this.send(account, delivery).catch(error => this.failDelivery(account, delivery, (error as Error).message))
        return answer(true, undefined, {
          sent: true,
          to: `@${recipient.handle}`,
          note:
            recipient.driver === 'terminal' && recipient.delivery === 'manual'
              ? 'That session takes messages when its user delivers them. The reply arrives here as a new message.'
              : 'The reply arrives here later as a new message.',
        })
      }
      if (tool === 'post_to_channel') {
        const input = args as { channel?: unknown; message?: unknown }
        if (typeof input.message !== 'string' || !input.message.trim()) return answer(false, 'Write a message.')
        if (input.message.length > chatLimits.text) return answer(false, 'The message is too long.')
        const name = typeof input.channel === 'string' ? input.channel.trim().replace(/^#/, '').toLowerCase() : ''
        const channel = account.store.channels.channels.find(
          item => item.name.toLowerCase() === name && item.members.some(member => self(member)),
        )
        const member = channel?.members.find(item => self(item))
        if (!channel || !member)
          return answer(false, `This session is not in #${name || '?'}. list_sessions shows its channels.`)
        if (!this.allowSend(ref))
          return answer(false, 'Too many messages this minute. Wait, or report back to the user.')
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
        this.broadcast(account, { type: 'message', message })
        await this.route(account, channel, message, member)
        return answer(true, undefined, { posted: true, channel: `#${channel.name}` })
      }
      if (tool === 'fetch_file') {
        const input = args as { session?: unknown; file?: unknown }
        const found = this.named(account, input.session)
        if ('problem' in found) return answer(false, found.problem)
        const owner = found.session
        if (typeof input.file !== 'string' || !input.file.trim()) return answer(false, 'Name the file or give its ID.')
        const signal = AbortSignal.timeout(120_000)
        const source = await this.dependencies.resolve(account.owner, owner.targetId)
        const files = await this.dependencies.files.list(source, owner.id, signal)
        const wanted = input.file.trim()
        const file = files.find(item => item.id === wanted) ?? [...files].reverse().find(item => item.name === wanted)
        if (!file)
          return answer(
            false,
            `@${owner.handle} has no file ${wanted}. Its files: ${files.map(item => item.name).join(', ') || 'none'}.`,
          )
        const { bytes } = await this.dependencies.files.read(source, owner.id, file.id, signal)
        const destination = await this.dependencies.resolve(account.owner, ref.targetId)
        const stored = await this.dependencies.files.receive(destination, ref.sessionId, file.name, bytes, signal)
        return answer(true, undefined, { stored: true, file: stored, from: `@${owner.handle}` })
      }
      return answer(false, 'Unknown Outpost tool.')
    } catch (error) {
      return answer(false, (error as Error).message)
    }
  }

  // Schedules -----------------------------------------------------------------------------------

  async saveSchedule(owner: Owner, input: ScheduleInput) {
    const account = await this.account(owner)
    try {
      parseCron(input.cron)
    } catch (error) {
      throw new AppError((error as Error).message, 400)
    }
    if (!validTimeZone(input.timeZone)) throw new AppError('Unknown time zone.', 400)
    await this.fresh(account)
    if (!this.find(account, input)) throw new AppError('The session was not found.', 404)
    const list = account.store.schedules.schedules
    const existing = input.id ? list.find(item => item.id === input.id) : undefined
    if (input.id && !existing) throw new AppError('Schedule not found.', 404)
    if (!existing && list.length >= chatLimits.schedules) throw new AppError('Too many schedules.', 409)
    const schedule: Schedule = {
      ...input,
      id: existing?.id ?? randomUUID(),
      name: input.name.trim(),
      createdAt: existing?.createdAt ?? now(),
      lastRun: existing?.lastRun ?? null,
    }
    await account.store.change(['schedules'], () => {
      const index = list.findIndex(item => item.id === schedule.id)
      if (index >= 0) list[index] = schedule
      else list.push(schedule)
    })
    this.broadcast(account, { type: 'schedule', schedule })
    return schedule
  }

  async deleteSchedule(owner: Owner, scheduleId: string) {
    const account = await this.account(owner)
    await account.store.change(['schedules'], () => {
      account.store.schedules.schedules = account.store.schedules.schedules.filter(item => item.id !== scheduleId)
      delete account.store.schedules.fired[scheduleId]
    })
    this.broadcast(account, { type: 'schedule-removed', scheduleId })
  }

  async runSchedule(owner: Owner, scheduleId: string) {
    const account = await this.account(owner)
    const schedule = account.store.schedules.schedules.find(item => item.id === scheduleId)
    if (!schedule) throw new AppError('Schedule not found.', 404)
    await this.fire(account, schedule)
  }

  private async fire(account: Account, schedule: Schedule) {
    const delivery = this.delivery(
      schedule,
      { kind: 'schedule', scheduleId: schedule.id },
      schedulePrompt(schedule.name, schedule.prompt),
      {
        kind: 'schedule',
        scheduleId: schedule.id,
        name: schedule.name,
      },
    )
    await this.add(account, delivery)
    void this.send(account, delivery).catch(error => this.failDelivery(account, delivery, (error as Error).message))
  }

  private async ran(account: Account, scheduleId: string, ok: boolean, message: string | null) {
    const schedule = account.store.schedules.schedules.find(item => item.id === scheduleId)
    if (!schedule) return
    await account.store.change(['schedules'], () => {
      schedule.lastRun = { at: now(), ok, message }
    })
    this.broadcast(account, { type: 'schedule', schedule })
  }

  /** Fire each enabled schedule once in each matching minute while the server runs. */
  private async tick() {
    if (this.stopped) return
    const at = new Date()
    for (const pending of this.accounts.values()) {
      const account = await pending.catch(() => null)
      if (!account || !this.dependencies.deployment.account(account.userId)) continue
      for (const schedule of account.store.schedules.schedules) {
        if (!schedule.enabled) continue
        let matches: boolean
        try {
          matches = cronMatches(parseCron(schedule.cron), at, schedule.timeZone)
        } catch {
          continue
        }
        const zoned = zonedParts(at, schedule.timeZone)
        const minute = `${zoned.year}-${zoned.month}-${zoned.day} ${zoned.hour}:${zoned.minute}`
        if (!matches || account.store.schedules.fired[schedule.id] === minute) continue
        await account.store.change(['schedules'], () => {
          account.store.schedules.fired[schedule.id] = minute
        })
        await this.fire(account, schedule).catch(error =>
          this.ran(account, schedule.id, false, (error as Error).message),
        )
      }
    }
  }

  async refreshFor(owner: Owner) {
    await this.refresh(await this.account(owner))
  }
}
