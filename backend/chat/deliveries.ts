import { randomUUID } from 'node:crypto'
import { sessionKey, type Delivery, type DeliverySource, type SessionRef } from '../../shared/chatApi'
import type { ChatOrigin } from '../../shared/chatHost'
import { replyText, turnFiles } from '../../shared/chatTranscript'
import type { TerminalDelivery } from '../../shared/machine'
import type { SessionFile } from '../../shared/sessionFiles'
import { AppError } from '../errors'
import { broadcast, findSession, linkKey, notStopped, now, promptKey, type Account, type HubRuntime } from './context'
import type { ChatLink } from './links'

export interface DeliveryCallbacks {
  deliverChannel(account: Account, delivery: Delivery): Promise<void>
  channelNotice(
    account: Account,
    channelId: string,
    level: 'info' | 'warning' | 'error',
    text: string,
    root: string,
  ): Promise<void>
  channelReply(
    account: Account,
    delivery: Delivery,
    source: Extract<DeliverySource, { kind: 'channel' }>,
    stop: { stopReason: string; error: string | null } | null,
    text: string,
    files: SessionFile[],
  ): Promise<void>
  sessionReply(
    account: Account,
    delivery: Delivery,
    source: Extract<DeliverySource, { kind: 'session' }>,
    stop: { stopReason: string; error: string | null } | null,
    text: string,
  ): Promise<void>
  scheduleRan(account: Account, scheduleId: string, ok: boolean, message: string | null): Promise<void>
}

export class DeliveryManager {
  private finishing = new Set<string>()
  /** Deliveries with a prompt request in flight. */
  private sending = new Set<string>()
  private terminalTimer: NodeJS.Timeout | null = null
  private polling = false

  constructor(
    private hub: HubRuntime,
    private callbacks: DeliveryCallbacks,
  ) {}

  close() {
    if (this.terminalTimer) clearInterval(this.terminalTimer)
    this.terminalTimer = null
  }

  create(ref: SessionRef, source: DeliverySource, prompt: string | null, origin: ChatOrigin | null): Delivery {
    const at = now()
    return {
      targetId: ref.targetId,
      sessionId: ref.sessionId,
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

  async add(account: Account, delivery: Delivery) {
    await account.store.change(['deliveries'], () => {
      account.store.deliveries.deliveries.push(delivery)
    })
    broadcast(account, { type: 'delivery', delivery })
  }

  /** Apply state transitions immediately for synchronous journal events, and
   * persist them serialized inside the store transaction. */
  async update(account: Account, delivery: Delivery, change: Partial<Delivery>) {
    if (!notStopped(delivery)) return
    const previous = delivery.state
    const patch = { ...change, updatedAt: now() }
    Object.assign(delivery, patch)
    if (delivery.state !== previous) this.logDelivery(account, delivery)
    broadcast(account, { type: 'delivery', delivery })
    await account.store.change(['deliveries'], () => {
      const stored = account.store.deliveries.deliveries.find(item => item.id === delivery.id)
      if (stored && stored !== delivery) Object.assign(stored, patch)
    })
  }

  private logDelivery(account: Account, delivery: Delivery) {
    if (delivery.state === 'pending' || delivery.state === 'running') return
    const { source } = delivery
    const channel =
      source.kind === 'channel' ? account.store.channels.channels.find(item => item.id === source.channelId) : undefined
    const member = channel?.members.find(item => sessionKey(item) === sessionKey(delivery))
    const session = findSession(account, delivery)
    const name = session?.name ?? member?.name ?? 'A session'
    const to = session ? `@${session.handle}` : member ? `@${member.handle}` : name
    const from =
      source.kind === 'channel'
        ? `#${channel?.name ?? 'a channel'}`
        : source.kind === 'session'
          ? `@${source.from.handle}`
          : `the schedule ${account.store.schedules.schedules.find(item => item.id === source.scheduleId)?.name ?? ''}`.trim()
    const what = source.kind === 'session' && source.reply ? 'a reply' : 'a message'
    const message =
      delivery.state === 'sent'
        ? `${to} received ${what} from ${from}`
        : delivery.state === 'done'
          ? source.kind === 'session' && source.reply
            ? `${to} took the reply from ${from}`
            : `${to} answered ${what} from ${from}`
          : `${to} could not take ${what} from ${from}: ${delivery.error}`
    this.hub.log(account, {
      level: delivery.state === 'failed' ? 'error' : 'info',
      kind: 'message',
      type: delivery.state === 'sent' ? 'delivered' : delivery.state === 'done' ? 'answered' : 'failed',
      message,
      machine: { id: delivery.targetId, name: account.machines.get(delivery.targetId)?.name ?? delivery.targetId },
      session: { id: delivery.sessionId, name },
      details: {
        delivery: delivery.id,
        source: source.kind,
        from,
        to,
        via: delivery.via,
        ...(channel ? { channel: channel.name } : {}),
        ...(delivery.error ? { error: delivery.error } : {}),
      },
    })
  }

  /** Queue a composed prompt in the member's chat. The prompt key dedupes resends
   * to the same host instance, so a resend after a lost answer cannot run twice. */
  async send(account: Account, delivery: Delivery) {
    if (this.hub.stopped || this.sending.has(delivery.id) || !notStopped(delivery)) return
    const { prompt, origin } = delivery
    if (!prompt || !origin) return this.fail(account, delivery, 'The message was not prepared for delivery.')
    // A session running in a terminal gets it typed in; any other one in its chat.
    if (delivery.via === 'terminal' || (delivery.via === null && findSession(account, delivery)?.driver === 'terminal'))
      return this.sendTerminal(account, delivery, prompt)
    this.sending.add(delivery.id)
    try {
      const link = await this.hub.link(account.owner, delivery)
      link.hold(delivery.id)
      link.ensure(true)
      const result = await link.request(
        {
          type: 'prompt',
          key: promptKey(delivery),
          origin,
          prompt: [{ type: 'text', text: prompt }],
          files: delivery.files,
        },
        this.hub.dependencies.promptMs ?? 180_000,
        instance => {
          if (delivery.host !== instance)
            void this.update(account, delivery, { state: 'sent', host: instance, via: 'chat' })
        },
      )
      // Unconfirmed: the journal's `queued` entry or the next reconnect settles it.
      if (this.hub.stopped || result.unknown) return
      if (!result.ok) return this.fail(account, delivery, result.message ?? 'The session did not accept the message.')
      const turn = (result.data as { turn?: string } | undefined)?.turn
      if (turn) await this.adopt(account, delivery, link, turn)
    } finally {
      this.sending.delete(delivery.id)
    }
  }

  /** Hand the message to the session's terminal service, which types it in when
   * the agent is idle and nobody is typing. The key makes a resend harmless. */
  private async sendTerminal(account: Account, delivery: Delivery, prompt: string) {
    this.sending.add(delivery.id)
    try {
      const context = await this.hub.dependencies.resolve(account.owner, delivery.targetId)
      const progress = await this.hub.dependencies.terminals.deliver(
        context,
        delivery.sessionId,
        promptKey(delivery),
        prompt,
        delivery.files,
      )
      if (delivery.via !== 'terminal') await this.update(account, delivery, { state: 'sent', via: 'terminal' })
      await this.progress(account, delivery, progress)
      this.watchTerminals()
    } catch (error) {
      await this.fail(account, delivery, (error as Error).message)
    } finally {
      this.sending.delete(delivery.id)
    }
  }

  /** Check on messages typed into terminals until they are answered. */
  private watchTerminals() {
    if (this.terminalTimer || this.hub.stopped) return
    this.terminalTimer = setInterval(() => void this.pollTerminals(), this.hub.dependencies.terminalPollMs ?? 2000)
    this.terminalTimer.unref()
  }

  private async pollTerminals() {
    if (this.polling) return
    this.polling = true
    let active = 0
    try {
      for (const pending of this.hub.accounts.values()) {
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
            const context = await this.hub.dependencies.resolve(account.owner, first.targetId)
            const found = await this.hub.dependencies.terminals.deliveries(
              context,
              first.sessionId,
              deliveries.map(promptKey),
            )
            for (const delivery of deliveries) {
              const progress = found.find(item => item.key === promptKey(delivery))
              if (progress) await this.progress(account, delivery, progress)
              else await this.fail(account, delivery, 'The session no longer has this message.')
            }
          } catch (error) {
            if (error instanceof AppError && [404, 409, 410].includes(error.statusCode)) {
              for (const delivery of deliveries) await this.fail(account, delivery, error.message)
            }
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
      await this.complete(
        account,
        delivery,
        { stopReason: 'end_turn', error: null },
        progress.reply ?? '',
        progress.files,
      )
    else if (progress.state === 'failed')
      await this.fail(account, delivery, progress.error ?? 'The session did not reply.')
  }

  /** The host accepted the delivery's prompt as `turn`. */
  async adopt(account: Account, delivery: Delivery, link: ChatLink, turn: string) {
    if (!notStopped(delivery) || delivery.turn === turn) return
    const started = link.journal.entries.some(entry => entry.kind === 'started' && entry.turn === turn)
    await this.update(account, delivery, { state: started ? 'running' : 'sent', turn, prompt: null })
    // A quick turn may have ended before its id was known.
    if (link.journal.entries.some(entry => entry.kind === 'ended' && entry.turn === turn))
      await this.finished(account, delivery, link)
  }

  async fail(account: Account, delivery: Delivery, error: string) {
    if (this.hub.stopped || !notStopped(delivery)) return
    this.hub.links.get(linkKey(account.userId, delivery))?.release(delivery.id)
    await this.update(account, delivery, { state: 'failed', error, prompt: null, rerun: null })
    const member = findSession(account, delivery)
    const name = member ? `@${member.handle}` : 'The session'
    const { source } = delivery
    if (source.kind === 'channel') {
      const channel = account.store.channels.channels.find(item => item.id === source.channelId)
      const recipient = channel?.members.find(item => sessionKey(item) === sessionKey(delivery))
      if (recipient)
        await this.callbacks.channelNotice(
          account,
          source.channelId,
          'warning',
          `@${recipient.handle} could not reply: ${error}`,
          source.root,
        )
    } else if (source.kind === 'session' && !source.reply) {
      const sender = await this.hub.link(account.owner, source.from).catch(() => null)
      sender?.ensure(false)
      await sender?.request({
        type: 'note',
        level: 'warning',
        text: `${name} could not receive your message: ${error}`,
      })
    } else if (source.kind === 'schedule') await this.callbacks.scheduleRan(account, source.scheduleId, false, error)
  }

  async finished(account: Account, delivery: Delivery, link: ChatLink) {
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
    if (source.kind === 'channel') await this.callbacks.channelReply(account, delivery, source, stop, text, files)
    else if (source.kind === 'session' && !source.reply)
      await this.callbacks.sessionReply(account, delivery, source, stop, text)
    else if (source.kind === 'schedule')
      await this.callbacks.scheduleRan(account, source.scheduleId, stop?.stopReason === 'end_turn', stop?.error ?? null)
  }

  /** After a (re)connect: settle deliveries whose turns ended or vanished, and
   * resend unconfirmed prompts to the host that may have them. */
  async reconcile(account: Account, ref: SessionRef, link: ChatLink) {
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
          await this.fail(
            account,
            delivery,
            'The session restarted before confirming the message; it may not have run.',
          )
      } else if (entries.some(entry => entry.kind === 'ended' && entry.turn === delivery.turn))
        await this.finished(account, delivery, link)
      else if (!link.journal.truncated && !entries.some(entry => 'turn' in entry && entry.turn === delivery.turn))
        await this.fail(account, delivery, 'The session restarted before replying.')
    }
  }

  async linkEnded(account: Account, ref: SessionRef, link: ChatLink, message: string | null) {
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
      else await this.fail(account, delivery, message ?? 'The session stopped before replying.')
    }
  }

  async recover(account: Account) {
    for (const delivery of account.store.deliveries.deliveries.filter(notStopped)) {
      try {
        if (delivery.state === 'pending') {
          if (delivery.prompt) await this.send(account, delivery)
          else if (delivery.source.kind === 'channel') await this.callbacks.deliverChannel(account, delivery)
          else await this.fail(account, delivery, 'Outpost restarted before sending this message.')
        } else if (delivery.via === 'terminal') this.watchTerminals()
        else {
          const link = await this.hub.link(account.owner, delivery)
          link.hold(delivery.id)
          link.ensure(false)
        }
      } catch (error) {
        await this.fail(account, delivery, (error as Error).message)
      }
    }
  }

  /** Retire every active delivery matching `predicate` and notify its source. */
  async retireMatching(account: Account, predicate: (delivery: Delivery) => boolean, error: string) {
    for (const delivery of account.store.deliveries.deliveries) {
      if (notStopped(delivery) && predicate(delivery)) await this.fail(account, delivery, error)
    }
  }
}
