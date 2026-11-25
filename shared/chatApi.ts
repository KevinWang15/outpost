// The chat app's contract between browser (or Outpost Desktop) and server:
// one WebSocket per page, `/api/chat`. Client messages are validated with
// these schemas; server messages are typed below. See docs/CHAT.md.
import Type, { type Static } from 'typebox'
import { chatHost, chatOrigin, type ChatEntry, type ChatInfo, type ChatJournalSnapshot } from './chatHost'
import type { Session } from './model'
import { conversationSearch, sessionForkInput, sessionInput, sessionUpdate } from './schemas'
import { sessionFileSchema } from './sessionFiles'

export const chatProtocol = 4
export const chatLimits = {
  text: 32 * 1024,
  members: 24,
  channels: 200,
  schedules: 100,
  /** Channel messages a member receives per turn, newest first. */
  delta: 30,
  deltaBytes: 16 * 1024,
  /** A chain of agent replies passing the floor stops after this many hops. */
  hops: 6,
  /** Deliveries started by one user message, across all hops. */
  chain: 12,
  /** Messages and channel posts one session's agent may send a minute. */
  sendsPerMinute: 20,
  /** Session-to-session messages within one thread. */
  threadHops: 6,
  page: 100,
} as const

// Stored records ---------------------------------------------------------------------

const strict = { additionalProperties: false } as const
const id = Type.String({ pattern: '^[A-Za-z0-9_-]{1,80}$' })
const uuid = Type.String({ pattern: '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$' })
const files = Type.Array(Type.String({ pattern: '^[0-9a-f]{32}$' }), { maxItems: chatHost.maxFiles })
const targetId = Type.String({ minLength: 1, maxLength: 80, pattern: '^[^\\u0000-\\u001f\\u007f]+$' })
const session = { targetId, sessionId: uuid }
const sessionRef = Type.Object(session, strict)
export type SessionRef = Static<typeof sessionRef>
const string = Type.String()
const nullableString = Type.Union([string, Type.Null()])
const hop = Type.Integer({ minimum: 0 })
const text = (maxLength: number) => Type.String({ maxLength, pattern: '^[^\\u0000]*$' })
const channelName = Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,39}$' })
const channelDetails = { name: channelName, topic: text(500) }
const member = Type.Object({ ...session, name: string, handle: string }, strict)
export type ChannelMember = Static<typeof member>
export const channelRecord = Type.Object(
  { id: uuid, ...channelDetails, members: Type.Array(member), createdAt: string },
  strict,
)
export type Channel = Static<typeof channelRecord>
const author = Type.Union([
  Type.Object({ kind: Type.Literal('user') }, strict),
  Type.Object({ kind: Type.Literal('session'), ...member.properties }, strict),
  Type.Object({ kind: Type.Literal('outpost'), level: Type.Enum(['info', 'warning', 'error']) }, strict),
])
export type MessageAuthor = Static<typeof author>
export const channelMessage = Type.Object(
  {
    id: uuid,
    channelId: uuid,
    at: string,
    author,
    text: string,
    /** Handles this message addressed. */
    mentions: Type.Array(string),
    /** The user message that began this chain of replies, and the reply depth. */
    root: string,
    hop,
    /** The member turn that produced this reply. */
    turn: Type.Union([Type.Object({ ...session, turn: string }, strict), Type.Null()]),
    /** Idempotency key for a user post or an automatic membership notice. */
    key: nullableString,
    /** A member reply: files its turn published, kept in that session's files.
     * A user post: files attached to it, kept with the channel on the server. */
    files: Type.Array(sessionFileSchema),
  },
  strict,
)
export type ChannelMessage = Static<typeof channelMessage>
const deliverySource = Type.Union([
  Type.Object({ kind: Type.Literal('channel'), channelId: uuid, root: string, hop, through: nullableString }, strict),
  Type.Object({ kind: Type.Literal('session'), threadId: string, hop, from: member, reply: Type.Boolean() }, strict),
  Type.Object({ kind: Type.Literal('schedule'), scheduleId: uuid }, strict),
])
export type DeliverySource = Static<typeof deliverySource>
export const deliveryRecord = Type.Object(
  {
    ...session,
    id: uuid,
    state: Type.Enum(['pending', 'sent', 'running', 'done', 'failed']),
    turn: nullableString,
    source: deliverySource,
    /** Mentioned again while working: deliver the newer messages next, in this chain. */
    rerun: Type.Union([Type.Object({ root: string, hop }, strict), Type.Null()]),
    /** The composed prompt, kept until it is accepted so a restart can resend it. */
    prompt: nullableString,
    /** Files sent with the prompt, already copied into the member's session files. */
    files,
    /** The chat host instance the prompt was sent to; a resend is safe only to the same one. */
    host: nullableString,
    /** How it reached the session: a chat prompt, or typed into its terminal. */
    via: Type.Union([Type.Enum(['chat', 'terminal']), Type.Null()]),
    origin: Type.Union([chatOrigin, Type.Null()]),
    error: nullableString,
    createdAt: string,
    updatedAt: string,
  },
  strict,
)
export type Delivery = Static<typeof deliveryRecord>

// Views ------------------------------------------------------------------------------

export interface ChatSession extends Session {
  targetId: string
  target: string
  handle: string
}
export interface ChatTarget {
  id: string
  name: string
  error: string | null
}
export interface ChannelView extends Channel {
  lastAt: string | null
  readAt: string | null
}

// Client → server ----------------------------------------------------------------------

const memberRefs = Type.Array(sessionRef, { maxItems: chatLimits.members })
const channelInput = Type.Union([
  Type.Object({ ...channelDetails, members: memberRefs }, strict),
  Type.Object({ id: uuid, ...channelDetails }, strict),
  Type.Object({ id: uuid, add: memberRefs, remove: memberRefs }, strict),
])
const scheduleInput = Type.Object(
  {
    id: Type.Optional(uuid),
    name: Type.String({ minLength: 1, maxLength: 80, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }),
    ...session,
    prompt: Type.String({ minLength: 1, maxLength: 16 * 1024, pattern: '^[^\\u0000]*\\S[^\\u0000]*$' }),
    cron: Type.String({ minLength: 9, maxLength: 120, pattern: '^[0-9*,/ -]+$' }),
    timeZone: Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_+/-]+$' }),
    enabled: Type.Boolean(),
  },
  strict,
)
export const scheduleRecord = Type.Object(
  {
    ...scheduleInput.properties,
    id: uuid,
    createdAt: string,
    lastRun: Type.Union([
      Type.Object({ at: string, ok: Type.Boolean(), message: nullableString }, strict),
      Type.Null(),
    ]),
  },
  strict,
)
export type Schedule = Static<typeof scheduleRecord>
const message = <K extends string, T extends Record<string, Type.TSchema>>(type: K, fields: T) =>
  Type.Object({ type: Type.Literal(type), ...fields }, strict)

export const chatClientMessage = Type.Union([
  message('open', { id, ...session, start: Type.Boolean() }),
  message('close', { ...session }),
  message('prompt', {
    id,
    ...session,
    key: id,
    text: text(chatLimits.text),
    /** The session's files, uploaded first (POST /api/chat/files/…). */
    files,
  }),
  message('cancel', { id, ...session }),
  message('unqueue', { id, ...session, turn: uuid }),
  message('permission', {
    id,
    ...session,
    request: uuid,
    optionId: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  }),
  message('config', {
    id,
    ...session,
    configId: Type.String({ minLength: 1, maxLength: 200 }),
    value: Type.Union([Type.String({ maxLength: 200 }), Type.Boolean()]),
  }),
  message('mode', { id, ...session, modeId: Type.String({ minLength: 1, maxLength: 200 }) }),
  message('seen', { ...session, completionId: Type.String({ pattern: '^[0-9a-f]{64}$' }) }),
  message('stop', { id, ...session }),
  /** Edit the session; launch configuration applies when it next starts. */
  message('session-update', { id, ...session, update: sessionUpdate }),
  /** Make an earlier conversation current (or reclaim a moved one); refused while the session runs. */
  message('session-switch', {
    id,
    ...session,
    conversation: Type.String({ minLength: 1, maxLength: 128 }),
    reclaim: Type.Optional(Type.Boolean()),
  }),
  /** Start a new conversation in the running chat, like /new in a terminal. */
  message('new-conversation', { id, ...session }),
  /** A new session on a new Git branch and worktree, from this one. */
  message('session-fork', { id, ...session, input: sessionForkInput }),
  /** Remove a stopped session from Outpost. */
  message('session-delete', { id, ...session }),
  message('channel-save', { id, channel: channelInput }),
  message('channel-delete', { id, channelId: uuid }),
  message('channel-history', { id, channelId: uuid, before: Type.Union([uuid, Type.Null()]) }),
  /** `files` are uploads staged for this channel (POST /api/chat/channels/…/files). */
  message('channel-post', { id, channelId: uuid, key: id, text: text(chatLimits.text), files }),
  message('channel-read', { channelId: uuid }),
  message('schedule-save', { id, schedule: scheduleInput }),
  message('schedule-delete', { id, scheduleId: uuid }),
  message('schedule-run', { id, scheduleId: uuid }),
  message('refresh', { id }),
  // Session management uses the authenticated chat connection.
  message('session-options', { id, targetId }),
  message('directories', {
    id,
    targetId,
    path: Type.String({ maxLength: 4096, pattern: '^(|~|(?:~/|/)[^\\u0000-\\u001f\\u007f]*)$' }),
  }),
  message('session-create', {
    id,
    targetId,
    requestId: uuid,
    input: sessionInput,
  }),
  /** Search the coding tools' history on one machine. */
  message('conversation-search', { id, targetId, search: conversationSearch }),
])
export type ChatClientMessage = Static<typeof chatClientMessage>
export type ChannelInput = Static<typeof channelInput>
export type ScheduleInput = Static<typeof scheduleInput>

// Server → client ---------------------------------------------------------------------------

export type LinkState = 'starting' | 'live' | 'stopped' | 'unavailable'
export type ChatServerMessage =
  | {
      type: 'hello'
      protocol: number
      token: string
      channels: ChannelView[]
      schedules: Schedule[]
      deliveries: Delivery[]
    }
  | { type: 'sessions'; sessions: ChatSession[]; targets: ChatTarget[] }
  | ({ type: 'journal'; info: ChatInfo | null; journal: ChatJournalSnapshot } & SessionRef)
  | ({ type: 'entry'; entry: ChatEntry } & SessionRef)
  | ({ type: 'info'; info: ChatInfo } & SessionRef)
  | ({ type: 'link'; state: LinkState; message: string | null } & SessionRef)
  | { type: 'channel'; channel: ChannelView }
  | { type: 'channel-removed'; channelId: string }
  | { type: 'message'; message: ChannelMessage }
  | { type: 'delivery'; delivery: Delivery }
  | { type: 'schedule'; schedule: Schedule }
  | { type: 'schedule-removed'; scheduleId: string }
  | { type: 'result'; id: string; ok: boolean; message?: string; data?: unknown }
  | { type: 'closed'; message: string }

export const sessionKey = (ref: SessionRef) => `${ref.targetId}/${ref.sessionId}`
