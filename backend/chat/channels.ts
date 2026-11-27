import { randomUUID } from 'node:crypto'
import {
  chatLimits,
  sessionKey,
  type Channel,
  type ChannelInput,
  type ChannelMember,
  type ChannelMessage,
  type ChannelView,
  type Delivery,
  type DeliverySource,
  type SessionRef,
} from '../../shared/chatApi'
import { chatHost } from '../../shared/chatHost'
import { mentions } from '../../shared/chatMentions'
import type { SessionFile } from '../../shared/sessionFiles'
import type { Owner } from '../deployment'
import { AppError } from '../errors'
import {
  broadcast,
  findSession,
  linkKey,
  notStopped,
  noticeMessage,
  now,
  type Account,
  type HubRuntime,
} from './context'
import type { DeliveryManager } from './deliveries'
import { channelPrompt, summary } from './prompts'

export class ChannelManager {
  constructor(
    private hub: HubRuntime,
    private deliveries: DeliveryManager,
  ) {}

  async channelView(account: Account, channel: Channel): Promise<ChannelView> {
    return {
      ...channel,
      lastAt: await account.store.lastAt(channel.id),
      readAt: account.store.channels.reads[channel.id] ?? null,
    }
  }

  async pruneMembers(account: Account, reason: (ref: SessionRef) => string | null) {
    if (!account.store.channels.channels.some(channel => channel.members.some(reason))) return
    const changes = await account.store.change(['channels'], async () => {
      const changes = []
      for (const channel of account.store.channels.channels) {
        const removed = channel.members.filter(member => reason(member))
        if (!removed.length) continue
        const notices: ChannelMessage[] = []
        for (const member of removed) {
          const message = noticeMessage(
            channel.id,
            'info',
            `@${member.handle} was removed from this channel because ${reason(member)}.`,
          )
          // Journal first. If interrupted before the roster is persisted, reconciliation
          // can replay this removal without losing or duplicating its notice.
          message.key = `membership:${sessionKey(member)}`
          if (!(await account.store.recent(channel.id)).some(item => item.key === message.key))
            notices.push(await account.store.appendInChange(message))
          delete account.store.channels.cursors[channel.id]?.[sessionKey(member)]
        }
        channel.members = channel.members.filter(member => !removed.includes(member))
        changes.push({ channel, removed, notices })
      }
      return changes
    })
    for (const { channel, removed, notices } of changes) {
      await this.retireDeliveries(account, channel, removed)
      for (const message of notices) broadcast(account, { type: 'message', message })
      broadcast(account, { type: 'channel', channel: await this.channelView(account, channel) })
    }
  }

  private retireDeliveries(account: Account, channel: Channel, removed: ChannelMember[]) {
    const keys = new Set(removed.map(sessionKey))
    return this.deliveries.retireMatching(
      account,
      delivery =>
        delivery.source.kind === 'channel' &&
        delivery.source.channelId === channel.id &&
        keys.has(sessionKey(delivery)),
      'The session left the channel.',
    )
  }

  async saveChannel(owner: Owner, input: ChannelInput) {
    const account = await this.hub.account(owner)
    await this.hub.fresh(account)
    const { channel, edited, removed, added } = await account.store.change(['channels'], () => {
      const list = account.store.channels.channels
      const existing = 'id' in input ? list.find(channel => channel.id === input.id) : undefined
      if ('id' in input && !existing) throw new AppError('Channel not found.', 404)
      if ('name' in input && list.some(channel => channel.name === input.name && channel !== existing))
        throw new AppError(`#${input.name} already exists.`, 409)
      if (!existing && list.length >= chatLimits.channels) throw new AppError('Too many channels.', 409)
      const removals = new Set('remove' in input ? input.remove.map(sessionKey) : [])
      const previous = existing?.members ?? []
      const removed = previous.filter(member => removals.has(sessionKey(member)))
      const retained = previous.filter(member => !removals.has(sessionKey(member)))
      const additions = 'add' in input ? input.add : 'members' in input ? input.members : []
      const requested = new Map(additions.map(ref => [sessionKey(ref), ref]))
      for (const member of retained) requested.delete(sessionKey(member))
      if (retained.length + requested.size > chatLimits.members)
        throw new AppError(`A channel can have up to ${chatLimits.members} members.`, 409)
      const used = new Set(retained.map(member => member.handle))
      const added = [...requested.values()].map(ref => {
        const session = findSession(account, ref)
        if (!session) throw new AppError('This session is no longer available to add.', 404)
        let handle = session.handle
        for (let suffix = 2; used.has(handle); suffix++) {
          const ending = `-${suffix}`
          handle = session.handle.slice(0, 48 - ending.length) + ending
        }
        used.add(handle)
        return { ...ref, name: session.name, handle }
      })
      const channel: Channel = existing ?? { id: randomUUID(), createdAt: now(), name: '', topic: '', members: [] }
      if ('name' in input) {
        channel.name = input.name
        channel.topic = input.topic.trim()
      }
      channel.members = [...retained, ...added]
      for (const member of removed) delete account.store.channels.cursors[channel.id]?.[sessionKey(member)]
      if (!existing) list.push(channel)
      return { channel, edited: Boolean(existing), added, removed }
    })
    if (edited) {
      await this.retireDeliveries(account, channel, removed)
      for (const [members, action] of [
        [added, 'joined'],
        [removed, 'left'],
      ] as const) {
        if (members.length)
          await this.notice(
            account,
            channel.id,
            'info',
            `${members.map(member => '@' + member.handle).join(', ')} ${action} the channel.`,
            randomUUID(),
          )
      }
    }
    const view = await this.channelView(account, channel)
    broadcast(account, { type: 'channel', channel: view })
    this.hub.log(account, {
      kind: 'channel',
      type: edited ? 'edited' : 'created',
      message: `#${channel.name} was ${edited ? 'edited' : 'created'} with ${channel.members.map(member => `@${member.handle}`).join(', ') || 'no members'}`,
      details: { channel: channel.name, members: channel.members.map(member => member.handle).join(', ') },
    })
    return view
  }

  async deleteChannel(owner: Owner, channelId: string) {
    const account = await this.hub.account(owner)
    const { removed, retired } = await account.store.change(['channels', 'deliveries'], () => {
      const data = account.store.channels
      const removed = data.channels.find(channel => channel.id === channelId)
      if (!removed) throw new AppError('Channel not found.', 404)
      data.channels = data.channels.filter(channel => channel.id !== channelId)
      delete data.reads[channelId]
      delete data.cursors[channelId]
      const retired: Delivery[] = []
      const at = now()
      for (const delivery of account.store.deliveries.deliveries)
        if (delivery.source.kind === 'channel' && delivery.source.channelId === channelId && notStopped(delivery)) {
          Object.assign(delivery, {
            state: 'failed',
            error: 'The channel was deleted.',
            prompt: null,
            rerun: null,
            updatedAt: at,
          })
          retired.push(delivery)
        }
      return { removed, retired }
    })
    for (const delivery of retired) {
      this.hub.links.get(linkKey(account.userId, delivery))?.release(delivery.id)
      broadcast(account, { type: 'delivery', delivery })
    }
    await account.store.removeMessages(channelId)
    await account.files.removeChannel(channelId)
    broadcast(account, { type: 'channel-removed', channelId })
    this.hub.log(account, {
      kind: 'channel',
      type: 'deleted',
      message: `#${removed.name} was deleted`,
      details: { channel: removed.name },
    })
  }

  async history(owner: Owner, channelId: string, before: string | null) {
    const account = await this.hub.account(owner)
    if (!account.store.channels.channels.some(channel => channel.id === channelId))
      throw new AppError('Channel not found.', 404)
    return account.store.page(channelId, before, chatLimits.page)
  }

  async markRead(owner: Owner, channelId: string) {
    const account = await this.hub.account(owner)
    const channel = await account.store.change(['channels'], () => {
      const found = account.store.channels.channels.find(item => item.id === channelId)
      if (!found) return null
      account.store.channels.reads[channelId] = now()
      return found
    })
    if (!channel) return
    broadcast(account, { type: 'channel', channel: await this.channelView(account, channel) })
  }

  async notice(account: Account, channelId: string, level: 'info' | 'warning' | 'error', text: string, root: string) {
    const message = noticeMessage(channelId, level, text, root)
    await account.store.append(message)
    broadcast(account, { type: 'message', message })
  }

  /** Post the user's message. A draft resent with the same key, also after a
   * restart, returns the first post. */
  async post(owner: Owner, channelId: string, key: string, text: string, files: string[] = []) {
    const account = await this.hub.account(owner)
    await this.hub.fresh(account)
    const channel = account.store.channels.channels.find(item => item.id === channelId)
    if (!channel) throw new AppError('Channel not found.', 404)
    const body = text.trim()
    if (!body && !files.length) throw new AppError('Write a message first.', 400)
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
    const previous = await account.store.change([], async () => {
      if (!account.store.channels.channels.includes(channel)) throw new AppError('Channel not found.', 404)
      const stored = await account.store.postId(channelId, key)
      if (stored) return stored
      message.files = await account.files.commit(channelId, files)
      await account.store.appendInChange(message)
    })
    if (previous) return { messageId: previous, duplicate: true }
    broadcast(account, { type: 'message', message })
    this.hub.log(account, {
      kind: 'message',
      type: 'posted',
      message: `You posted in #${channel.name}${message.mentions.length ? ` for ${message.mentions.map(handle => `@${handle}`).join(', ')}` : ''}`,
      details: { channel: channel.name, text: body.slice(0, 500), mentions: message.mentions.join(', ') },
    })
    await this.markRead(owner, channelId)
    await this.route(account, channel, message, null)
    return { messageId: id, duplicate: false }
  }

  /** Deliver a channel message to the members it mentions. */
  async route(account: Account, channel: Channel, message: ChannelMessage, author: SessionRef | null) {
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
        await this.deliveries.update(account, busy, { rerun: { root: message.root, hop: message.hop } })
        continue
      }
      const delivery = this.deliveries.create(
        member,
        { kind: 'channel', channelId: channel.id, root: message.root, hop: message.hop, through: null },
        null,
        null,
      )
      await this.deliveries.add(account, delivery)
      void this.deliverChannel(account, delivery).catch(error =>
        this.deliveries.fail(account, delivery, (error as Error).message),
      )
    }
  }

  /** Compose the member's prompt from the messages it has not received. */
  async deliverChannel(account: Account, delivery: Delivery) {
    const source = delivery.source
    if (source.kind !== 'channel') return
    const channel = account.store.channels.channels.find(item => item.id === source.channelId)
    const member = channel?.members.find(item => sessionKey(item) === sessionKey(delivery))
    if (!channel || !member) return this.deliveries.fail(account, delivery, 'The channel or member was removed.')
    const cursor = account.store.channels.cursors[channel.id]?.[sessionKey(member)]
    const messages = await account.store.recent(channel.id)
    const start = cursor ? messages.findIndex(item => item.id === cursor) + 1 : 0
    const delta = messages
      .slice(start)
      .filter(item => !(item.author.kind === 'session' && sessionKey(item.author) === sessionKey(member)))
    if (!delta.length) return this.deliveries.update(account, delivery, { state: 'done' })
    const trigger = [...delta].reverse().find(item => item.mentions.includes(member.handle)) ?? delta.at(-1)!
    const attached = await this.memberFiles(account, channel, member, delta)
    await this.deliveries.update(account, delivery, {
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
    await this.deliveries.send(account, delivery)
  }

  /** Give the member the files in its new messages, newest first: each is
   * copied into the member's own session files, where its tools can read it. */
  private async memberFiles(account: Account, channel: Channel, member: SessionRef, messages: ChannelMessage[]) {
    const files: string[] = []
    const missing: string[] = []
    const signal = AbortSignal.timeout(120_000)
    const destination = await this.hub.dependencies.resolve(account.owner, member.targetId)
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
                  await this.hub.dependencies.files.read(
                    await this.hub.dependencies.resolve(account.owner, author.targetId),
                    author.sessionId,
                    file.id,
                    signal,
                  )
                ).bytes
              : (await account.files.read(channel.id, file.id)).bytes
          files.push(
            (await this.hub.dependencies.files.receive(destination, member.sessionId, file.name, bytes, signal)).id,
          )
        } catch (error) {
          missing.push(`${file.name} (${(error as Error).message})`)
        }
      }
    return { files, missing }
  }

  async stageFile(owner: Owner, channelId: string, name: string, data: Buffer) {
    const account = await this.hub.account(owner)
    if (!account.store.channels.channels.some(channel => channel.id === channelId))
      throw new AppError('Channel not found.', 404)
    return account.files.stage(name, data)
  }

  async channelFiles(owner: Owner, channelId: string) {
    const account = await this.hub.account(owner)
    if (!account.store.channels.channels.some(channel => channel.id === channelId))
      throw new AppError('Channel not found.', 404)
    return account.files.list(channelId)
  }

  async readChannelFile(owner: Owner, channelId: string, fileId: string) {
    const account = await this.hub.account(owner)
    if (!account.store.channels.channels.some(channel => channel.id === channelId))
      throw new AppError('Channel not found.', 404)
    return account.files.read(channelId, fileId)
  }

  async channelReply(
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
      broadcast(account, { type: 'message', message })
      await this.route(account, channel, message, member)
    }
    if (delivery.rerun) {
      const next = this.deliveries.create(
        member,
        { kind: 'channel', channelId: channel.id, ...delivery.rerun, through: null },
        null,
        null,
      )
      await this.deliveries.add(account, next)
      void this.deliverChannel(account, next).catch(error =>
        this.deliveries.fail(account, next, (error as Error).message),
      )
    }
  }
}
