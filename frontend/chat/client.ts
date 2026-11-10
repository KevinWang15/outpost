// The chat page's connection and state: one WebSocket to /api/chat, the session
// list across targets, one journal per open session, and channel messages.
import type * as acp from '@agentclientprotocol/sdk'
import {
  chatProtocol,
  sessionKey,
  type ChannelMessage,
  type ChannelView,
  type ChatClientMessage,
  type ChatServerMessage,
  type ChatSession,
  type ChatTarget,
  type Delivery,
  type LinkState,
  type Schedule,
  type SessionRef,
} from '../../shared/chatApi'
import { ChatJournal, type ChatInfo } from '../../shared/chatHost'
import { transcript, type Transcript } from '../../shared/chatTranscript'

export interface Conversation {
  journal: ChatJournal | null
  info: ChatInfo | null
  link: LinkState
  message: string | null
  /** The page wants this session's journal (an open view or expanded steps). */
  wanted: number
  /** An open asked to start the tool before the socket could carry it. */
  start: boolean
}
export interface ChannelState {
  messages: ChannelMessage[]
  more: boolean
  loading: boolean
}
type Status = 'connecting' | 'live' | 'closed'
type Request = Extract<ChatClientMessage, { id: string }>
export type ChatRequest = Request extends infer R ? (R extends Request ? Omit<R, 'id'> : never) : never
export interface Result {
  ok: boolean
  message?: string
  data?: unknown
}

const transcripts = new WeakMap<ChatJournal, { version: number; value: Transcript }>()
/** Memoized display model; recomputed when the journal changes. */
export function transcriptOf(journal: ChatJournal) {
  const cached = transcripts.get(journal)
  if (cached && cached.version === journal.version) return cached.value
  const value = transcript(journal.entries, journal.truncated)
  transcripts.set(journal, { version: journal.version, value })
  return value
}

export const newKey = () => crypto.randomUUID().replace(/-/g, '')
/** Exactly the reference fields; the server rejects unknown properties. */
export const plainRef = ({ targetId, sessionId }: SessionRef): SessionRef => ({ targetId, sessionId })

export class ChatClient {
  version = 0
  status: Status = 'connecting'
  closedMessage: string | null = null
  sessions: ChatSession[] = []
  targets: ChatTarget[] = []
  sessionsLoaded = false
  channels = new Map<string, ChannelView>()
  schedules = new Map<string, Schedule>()
  deliveries = new Map<string, Delivery>()
  conversations = new Map<string, Conversation>()
  channelMessages = new Map<string, ChannelState>()
  /** Prompt images by message key, for this page's own sent messages. */
  previews = new Map<string, string[]>()
  token = ''
  private socket: WebSocket | null = null
  private pending = new Map<string, (result: Result) => void>()
  private listeners = new Set<() => void>()
  private frame = 0
  private retry: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  /** Changes on every connect/dispose; late callbacks of an older one are ignored. */
  private epoch = 0
  private disposed = false

  constructor(private ticket: (() => Promise<string>) | null) {}

  // Store -------------------------------------------------------------------------------

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
  getVersion = () => this.version

  /** Coalesce renders to one per frame; streamed tokens arrive far faster. */
  private changed() {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.version++
      for (const listener of this.listeners) listener()
    })
  }

  // Connection ------------------------------------------------------------------------------

  async connect() {
    this.disposed = false
    const epoch = ++this.epoch
    this.status = 'connecting'
    this.changed()
    let query = `protocol=${chatProtocol}`
    try {
      if (this.ticket) query += `&ticket=${encodeURIComponent(await this.ticket())}`
    } catch (error) {
      if (epoch === this.epoch) this.lost((error as Error).message || 'Could not sign in to the server.')
      return
    }
    if (epoch !== this.epoch) return
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${scheme}://${location.host}/api/chat?${query}`)
    this.socket = socket
    socket.onmessage = event => {
      if (this.socket !== socket) return
      try {
        this.receive(JSON.parse(event.data as string))
      } catch {
        socket.close()
      }
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.lost(this.closedMessage)
    }
  }

  private lost(message: string | null) {
    for (const resolve of this.pending.values())
      resolve({ ok: false, message: 'The connection was lost. Check before retrying.' })
    this.pending.clear()
    this.status = 'closed'
    this.closedMessage = message
    // Keep showing the last journal until a fresh snapshot replaces it, but
    // never apply live entries to it; the reconnect sends a new snapshot.
    for (const conversation of this.conversations.values()) conversation.link = 'starting'
    this.changed()
    if (this.disposed || message === 'Outpost was updated. Reload this page.') return
    if (message === 'Sign in to continue.' && !this.ticket) {
      window.dispatchEvent(new Event('outpost:unauthorized'))
      return
    }
    const delay = Math.min(30_000, 1000 * 2 ** this.attempts++) * (0.5 + Math.random() / 2)
    this.retry = setTimeout(() => void this.connect(), delay)
  }

  /** Reconnect at once, e.g. when the page becomes visible again. */
  wake() {
    if (this.status !== 'closed' || this.disposed) return
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    void this.connect()
  }

  /** Close the connection; connect() may start it again (React remounts effects). */
  dispose() {
    this.disposed = true
    this.epoch++
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const socket = this.socket
    this.socket = null
    socket?.close()
  }

  private send(message: ChatClientMessage) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(message))
    return true
  }

  request(message: ChatRequest): Promise<Result> {
    if (this.status !== 'live') return Promise.resolve({ ok: false, message: 'Not connected. Reconnecting…' })
    const id = newKey()
    return new Promise(resolve => {
      this.pending.set(id, resolve)
      this.send({ ...message, id } as ChatClientMessage)
    })
  }

  /** Like request, but throws the server's message. */
  async call<T = unknown>(message: ChatRequest): Promise<T> {
    const result = await this.request(message)
    if (!result.ok) throw new Error(result.message ?? 'The request failed.')
    return result.data as T
  }

  private receive(message: ChatServerMessage) {
    switch (message.type) {
      case 'hello':
        this.status = 'live'
        this.closedMessage = null
        this.attempts = 0
        this.token = message.token
        this.channels = new Map(message.channels.map(channel => [channel.id, channel]))
        this.schedules = new Map(message.schedules.map(schedule => [schedule.id, schedule]))
        this.deliveries = new Map(message.deliveries.map(delivery => [delivery.id, delivery]))
        // Reopen what the page shows. A reconnect never restarts a stopped coding
        // tool; only an open that did not reach the server keeps its intent.
        for (const [key, conversation] of this.conversations)
          if (conversation.wanted > 0) {
            this.send({ type: 'open', id: newKey(), ...refOf(key), start: conversation.start })
            conversation.start = false
          }
        for (const [channelId, state] of this.channelMessages)
          if (!state.loading) void this.loadChannel(channelId, true)
        break
      case 'sessions':
        this.sessions = message.sessions
        this.targets = message.targets
        this.sessionsLoaded = true
        break
      case 'journal': {
        const conversation = this.conversation(message)
        const journal = new ChatJournal()
        journal.load(message.journal)
        conversation.journal = journal
        conversation.info = message.info
        // A snapshot comes only from a live link.
        conversation.link = 'live'
        conversation.message = null
        break
      }
      case 'entry': {
        const conversation = this.conversations.get(sessionKey(message))
        if (!conversation?.journal || conversation.link !== 'live') break
        if (!conversation.journal.accept(message.entry))
          this.send({ type: 'open', id: newKey(), ...refOf(sessionKey(message)), start: false })
        break
      }
      case 'info':
        this.conversation(message).info = message.info
        break
      case 'link': {
        const conversation = this.conversation(message)
        conversation.link = message.state
        conversation.message = message.message
        break
      }
      case 'channel':
        this.channels.set(message.channel.id, message.channel)
        break
      case 'channel-removed':
        this.channels.delete(message.channelId)
        this.channelMessages.delete(message.channelId)
        break
      case 'message': {
        const { message: item } = message
        const channel = this.channels.get(item.channelId)
        if (channel) this.channels.set(channel.id, { ...channel, lastAt: item.at })
        const state = this.channelMessages.get(item.channelId)
        if (state && !state.messages.some(existing => existing.id === item.id))
          state.messages = [...state.messages, item]
        break
      }
      case 'delivery':
        this.deliveries.set(message.delivery.id, message.delivery)
        break
      case 'schedule':
        this.schedules.set(message.schedule.id, message.schedule)
        break
      case 'schedule-removed':
        this.schedules.delete(message.scheduleId)
        break
      case 'result': {
        const resolve = this.pending.get(message.id)
        this.pending.delete(message.id)
        resolve?.({ ok: message.ok, message: message.message, data: message.data })
        break
      }
      case 'closed':
        this.closedMessage = message.message
        break
    }
    this.changed()
  }

  // Sessions ---------------------------------------------------------------------------------

  private conversation(ref: SessionRef) {
    const key = sessionKey(ref)
    let conversation = this.conversations.get(key)
    if (!conversation) {
      conversation = { journal: null, info: null, link: 'starting', message: null, wanted: 0, start: false }
      this.conversations.set(key, conversation)
    }
    return conversation
  }

  /** Follow a session's chat while a view shows it. `start` restarts a stopped tool. */
  open(target: SessionRef, start: boolean) {
    const ref = plainRef(target)
    const conversation = this.conversation(ref)
    conversation.wanted++
    if (!this.send({ type: 'open', id: newKey(), ...ref, start }) && start) conversation.start = true
    this.changed()
    return () => {
      conversation.wanted--
      if (conversation.wanted <= 0) {
        conversation.wanted = 0
        // An unfollowed journal goes stale; the next open gets a fresh snapshot.
        conversation.journal = null
        conversation.link = 'starting'
        this.send({ type: 'close', ...ref })
      }
    }
  }

  /** Start a stopped session's coding tool again. */
  restart(target: SessionRef) {
    const ref = plainRef(target)
    if (!this.send({ type: 'open', id: newKey(), ...ref, start: true })) this.conversation(ref).start = true
  }

  seen(target: SessionRef, completionId: string) {
    this.send({ type: 'seen', ...plainRef(target), completionId })
  }

  session(ref: SessionRef) {
    return this.sessions.find(item => item.targetId === ref.targetId && item.id === ref.sessionId) ?? null
  }

  async upload(file: File) {
    const response = await fetch('/api/chat/images', {
      method: 'POST',
      headers: { 'x-outpost-request': '1', authorization: `Bearer ${this.token}`, 'content-type': file.type },
      body: file,
    })
    if (!response.ok)
      throw new Error((await response.json().catch(() => null))?.message ?? 'Could not upload the image.')
    return ((await response.json()) as { id: string }).id
  }

  /** Send a prompt; resending it with the same key cannot run it twice. */
  async prompt(target: SessionRef, text: string, images: File[], key: string) {
    const ref = plainRef(target)
    const ids: string[] = []
    for (const file of images) ids.push(await this.upload(file))
    if (images.length)
      this.previews.set(
        key,
        images.map(file => URL.createObjectURL(file)),
      )
    const result = await this.request({ type: 'prompt', ...ref, key, text, images: ids })
    if (!result.ok) throw new Error(result.message ?? 'The message was not sent.')
  }

  // Channels -------------------------------------------------------------------------------

  async loadChannel(channelId: string, reset = false) {
    let state = this.channelMessages.get(channelId)
    if (state?.loading) return
    if (!state || reset) {
      state = { messages: reset ? (state?.messages ?? []) : [], more: false, loading: true }
      this.channelMessages.set(channelId, state)
    } else state.loading = true
    this.changed()
    const before = reset ? null : (state.messages[0]?.id ?? null)
    const result = await this.request({ type: 'channel-history', channelId, before })
    state.loading = false
    if (result.ok) {
      const page = result.data as { messages: ChannelMessage[]; more: boolean }
      const known = new Map(state.messages.map(item => [item.id, item]))
      for (const item of page.messages) known.set(item.id, item)
      state.messages = [...known.values()].sort((a, b) => a.at.localeCompare(b.at))
      if (!reset || !before) state.more = page.more
    }
    this.changed()
  }

  async readChannel(channelId: string) {
    const channel = this.channels.get(channelId)
    if (!channel || (channel.readAt && channel.lastAt && channel.readAt >= channel.lastAt)) return
    this.send({ type: 'channel-read', channelId })
  }
}

export const refOf = (key: string): SessionRef => {
  const index = key.lastIndexOf('/')
  return { targetId: key.slice(0, index), sessionId: key.slice(index + 1) }
}

export type ContentBlock = acp.ContentBlock
