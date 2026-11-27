import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { sessionKey, type ChannelInput, type ScheduleInput, type SessionRef } from '../../shared/chatApi'
import { handles } from '../../shared/chatMentions'
import type { Owner } from '../deployment'
import type { LogInput } from '../logs/activity'
import { AgentTools } from './agentTools'
import { ChannelManager } from './channels'
import {
  broadcast,
  linkKey,
  notStopped,
  promptKey,
  sessionOf,
  type Account,
  type ChatClient,
  type ChatHubDependencies,
  type HubRuntime,
} from './context'
import { DeliveryManager } from './deliveries'
import { ChannelFiles } from './files'
import { ChatLink, type LinkEvent } from './links'
import { ScheduleManager } from './schedules'
import { ChatStore } from './store'

export type { ChatClient }

const pollMs = 15_000
const staleMs = 60_000
const refreshConcurrency = 3

/** Chat across all of an owner's targets: session lists, links to chat hosts,
 * channel routing, session-to-session messages and schedules. */
export class ChatHub implements HubRuntime {
  readonly accounts = new Map<string, Promise<Account>>()
  readonly links = new Map<string, ChatLink>()
  stopped = false
  private ticker: NodeJS.Timeout | null = null
  private deliveries: DeliveryManager
  private channels: ChannelManager
  private schedules: ScheduleManager
  private tools: AgentTools

  constructor(readonly dependencies: ChatHubDependencies) {
    this.deliveries = new DeliveryManager(this, {
      deliverChannel: (account, delivery) => this.channels.deliverChannel(account, delivery),
      channelNotice: (account, channelId, level, text, root) =>
        this.channels.notice(account, channelId, level, text, root),
      channelReply: (account, delivery, source, stop, text, files) =>
        this.channels.channelReply(account, delivery, source, stop, text, files),
      sessionReply: (account, delivery, source, stop, text) =>
        this.tools.sessionReply(account, delivery, source, stop, text),
      scheduleRan: (account, scheduleId, ok, message) => this.schedules.ran(account, scheduleId, ok, message),
    })
    this.channels = new ChannelManager(this, this.deliveries)
    this.schedules = new ScheduleManager(this, this.deliveries)
    this.tools = new AgentTools(this, this.deliveries, this.channels)
  }

  // Accounts -------------------------------------------------------------------------

  account(owner: Owner): Promise<Account> {
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
          deletedDuringRefresh: new Set(),
          viewKey: '',
          poller: null,
        }
      })()
      account.catch(() => this.accounts.delete(owner.userId))
      this.accounts.set(owner.userId, account)
    }
    return account
  }

  evictAccount(userId: string) {
    const pending = this.accounts.get(userId)
    this.accounts.delete(userId)
    for (const [key, link] of [...this.links.entries()]) {
      if (key.startsWith(`${userId}/`)) link.dispose()
    }
    void pending?.then(
      account => {
        if (account.poller) clearInterval(account.poller)
        account.poller = null
      },
      () => {},
    )
  }

  log(account: Account, input: LogInput) {
    this.dependencies.log?.(account.owner, input)
  }

  /** Recover in-flight work and start schedules (server start). */
  async start() {
    for (const owner of this.dependencies.deployment.backgroundOwners()) {
      try {
        // Work created by a schedule or the machine's MCP is restored even if nobody opened Chat.
        await access(join(this.dependencies.deployment.workspace(owner).directory, 'chat'))
        const account = await this.account(owner)
        // Reconcile membership before resending any pending channel messages.
        void this.refresh(account)
          .then(() => this.deliveries.recover(account))
          .catch(() => {})
      } catch {
        // A store with an invalid schema stays untouched; its owner sees the error.
      }
    }
    this.ticker = setInterval(() => void this.schedules.tick(), 20_000)
    this.ticker.unref()
  }

  /** Stop server-side work; chat hosts on targets keep running. */
  close() {
    this.stopped = true
    if (this.ticker) clearInterval(this.ticker)
    this.deliveries.close()
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
    if (!account.poller) {
      account.poller = setInterval(() => void this.refresh(account), pollMs)
      account.poller.unref()
    }
    void this.refresh(account)
    return {
      account,
      hello: {
        channels: await Promise.all(
          account.store.channels.channels.map(channel => this.channels.channelView(account, channel)),
        ),
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

  // Session lists ----------------------------------------------------------------------

  refresh(account: Account): Promise<void> {
    account.refreshing ??= (async () => {
      try {
        const targets = await this.dependencies.deployment.workspace(account.owner).list()
        const enrolled = new Set(targets.map(machine => machine.id))
        account.machines = new Map(targets.map(target => [target.id, { name: target.name }]))
        let next = 0
        await Promise.all(
          Array.from({ length: Math.min(refreshConcurrency, targets.length) }, async () => {
            while (next < targets.length && !this.stopped) {
              const target = targets[next++]
              try {
                const context = await this.dependencies.resolve(account.owner, target.id)
                const sessions = await this.dependencies.list(context, AbortSignal.timeout(45_000))
                account.sessions.set(
                  target.id,
                  sessions.filter(
                    session =>
                      !account.deletedDuringRefresh.has(sessionKey({ targetId: target.id, sessionId: session.id })),
                  ),
                )
                account.errors.delete(target.id)
              } catch (error) {
                account.errors.set(target.id, (error as Error).message)
              }
            }
          }),
        )
        for (const id of account.sessions.keys()) if (!account.machines.has(id)) account.sessions.delete(id)
        account.refreshedAt = Date.now()
        this.rebuild(account)
        const listed = new Map(
          [...account.sessions]
            .filter(([id]) => !account.errors.has(id))
            .map(([id, sessions]) => [id, new Set(sessions.map(session => session.id))]),
        )
        await this.channels.pruneMembers(account, ref => {
          if (!enrolled.has(ref.targetId)) return 'its machine was removed'
          if (listed.get(ref.targetId)?.has(ref.sessionId) === false) return 'the session was deleted'
          return null
        })
        for (const [targetId, sessions] of account.sessions)
          for (const session of sessions)
            if (session.driver === 'chat' && ['working', 'waiting'].includes(session.activity.state))
              void this.link(account.owner, { targetId, sessionId: session.id }).then(
                link => link.ensure(false),
                () => {},
              )
      } finally {
        account.deletedDuringRefresh.clear()
        account.refreshing = null
      }
    })()
    return account.refreshing
  }

  async fresh(account: Account) {
    if (Date.now() - account.refreshedAt > staleMs) await this.refresh(account)
  }

  private rebuild(account: Account) {
    const items = [...account.sessions.entries()].flatMap(([targetId, sessions]) =>
      sessions.map(session => ({ targetId, target: account.machines.get(targetId)?.name ?? targetId, session })),
    )
    const named = handles(items.map(item => ({ ...item, sessionId: item.session.id, name: item.session.name })))
    account.view = items.map(({ targetId, target, session }) => {
      const link = this.links.get(linkKey(account.userId, { targetId, sessionId: session.id }))
      const live = link?.state === 'live' ? link.info : null
      return {
        ...session,
        ...(live
          ? {
              activity: live.activity,
              driver: live.nativeTerminal ? ('terminal' as const) : ('chat' as const),
              status: live.nativeTerminal ? session.status : ('attached' as const),
            }
          : {}),
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
    broadcast(account, { type: 'sessions', sessions: account.view, targets: account.targets })
  }

  // Links -------------------------------------------------------------------------------

  /** The shared link to a session's chat host; resolving the target checks ownership. */
  async link(owner: Owner, ref: SessionRef): Promise<ChatLink> {
    const account = await this.account(owner)
    const key = linkKey(account.userId, ref)
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
    if (event.type === 'link' && event.state === 'unavailable')
      this.log(account, {
        level: 'error',
        kind: 'session',
        type: 'chat-unavailable',
        message: `${sessionOf(account, ref).session.name} could not open in chat${event.message ? `: ${event.message}` : ''}`,
        ...sessionOf(account, ref),
        details: { error: event.message },
      })
    if (event.type === 'entry') {
      const { entry } = event
      if (entry.kind === 'queued' && entry.key) {
        // The host accepted a prompt; its answer carries the same turn but may be lost.
        const delivery = account.store.deliveries.deliveries.find(
          item =>
            !item.turn && notStopped(item) && promptKey(item) === entry.key && sessionKey(item) === sessionKey(ref),
        )
        if (delivery) void this.deliveries.adopt(account, delivery, link, entry.turn)
      }
      if (entry.kind === 'started' || entry.kind === 'ended') {
        const delivery = account.store.deliveries.deliveries.find(
          item =>
            item.targetId === ref.targetId &&
            item.sessionId === ref.sessionId &&
            item.turn === entry.turn &&
            notStopped(item),
        )
        if (delivery && entry.kind === 'started') void this.deliveries.update(account, delivery, { state: 'running' })
        if (delivery && entry.kind === 'ended') void this.deliveries.finished(account, delivery, link)
      }
    } else if (event.type === 'journal') {
      void this.deliveries.reconcile(account, ref, link)
    } else if (event.type === 'info' || event.type === 'link') {
      this.rebuild(account)
      if (event.type === 'link' && (event.state === 'stopped' || event.state === 'unavailable')) {
        void this.deliveries.linkEnded(account, ref, link, event.message)
        void this.refresh(account)
      }
    }
  }

  // Deletion fan-out -------------------------------------------------------------------

  async sessionDeleted(owner: Owner, ref: SessionRef) {
    const account = await this.account(owner)
    this.links.get(linkKey(account.userId, ref))?.dispose()
    // An inventory request already in flight may have seen the session before deletion.
    if (account.refreshing) account.deletedDuringRefresh.add(sessionKey(ref))
    const sessions = account.sessions.get(ref.targetId)
    if (sessions)
      account.sessions.set(
        ref.targetId,
        sessions.filter(item => item.id !== ref.sessionId),
      )
    this.rebuild(account)
    await this.channels.pruneMembers(account, member =>
      sessionKey(member) === sessionKey(ref) ? 'the session was deleted' : null,
    )
    await this.deliveries.retireMatching(
      account,
      delivery => sessionKey(delivery) === sessionKey(ref),
      'The session was deleted.',
    )
  }

  async targetDeleted(owner: Owner, targetId: string) {
    const pending = this.accounts.get(owner.userId)
    if (!pending) return
    const account = await pending.catch(() => null)
    if (!account) return
    const prefix = `${account.userId}/${targetId}/`
    for (const [key, link] of [...this.links.entries()]) {
      if (key.startsWith(prefix)) link.dispose()
    }
    account.sessions.delete(targetId)
    account.machines.delete(targetId)
    account.errors.delete(targetId)
    this.rebuild(account)
    await this.channels.pruneMembers(account, member =>
      member.targetId === targetId ? 'its machine was removed' : null,
    )
    await this.deliveries.retireMatching(
      account,
      delivery => delivery.targetId === targetId,
      'The machine was removed.',
    )
  }

  // Public facades ---------------------------------------------------------------------

  saveChannel(owner: Owner, input: ChannelInput) {
    return this.channels.saveChannel(owner, input)
  }
  deleteChannel(owner: Owner, channelId: string) {
    return this.channels.deleteChannel(owner, channelId)
  }
  history(owner: Owner, channelId: string, before: string | null) {
    return this.channels.history(owner, channelId, before)
  }
  markRead(owner: Owner, channelId: string) {
    return this.channels.markRead(owner, channelId)
  }
  post(owner: Owner, channelId: string, key: string, text: string, files: string[] = []) {
    return this.channels.post(owner, channelId, key, text, files)
  }
  stageFile(owner: Owner, channelId: string, name: string, data: Buffer) {
    return this.channels.stageFile(owner, channelId, name, data)
  }
  channelFiles(owner: Owner, channelId: string) {
    return this.channels.channelFiles(owner, channelId)
  }
  readChannelFile(owner: Owner, channelId: string, fileId: string) {
    return this.channels.readChannelFile(owner, channelId, fileId)
  }
  saveSchedule(owner: Owner, input: ScheduleInput) {
    return this.schedules.saveSchedule(owner, input)
  }
  deleteSchedule(owner: Owner, scheduleId: string) {
    return this.schedules.deleteSchedule(owner, scheduleId)
  }
  runSchedule(owner: Owner, scheduleId: string) {
    return this.schedules.runSchedule(owner, scheduleId)
  }
  async agent(owner: Owner, ref: SessionRef, tool: string, args: Record<string, unknown>) {
    return this.tools.call(await this.account(owner), ref, tool, args)
  }
  async refreshFor(owner: Owner) {
    await this.refresh(await this.account(owner))
  }
}
