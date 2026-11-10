// The chat app's contract between browser (or Outpost Desktop) and server:
// one WebSocket per page, `/api/chat`. Client messages are validated with
// these schemas; server messages are typed below. See docs/CHAT.md.
import Type, { type Static } from 'typebox'
import type { ChatEntry, ChatInfo, ChatJournalSnapshot, ChatOrigin } from './chatHost'
import type { Session } from './model'
import { sessionInput } from './schemas'
import type { SessionFile } from './sessionFiles'

export const chatProtocol = 1
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
  /** Session-to-session messages within one thread. */
  threadHops: 6,
  page: 100,
} as const

// Stored records ---------------------------------------------------------------------

export interface SessionRef {
  targetId: string
  sessionId: string
}
export interface ChannelMember extends SessionRef {
  name: string
  handle: string
}
export interface Channel {
  id: string
  name: string
  topic: string
  members: ChannelMember[]
  createdAt: string
}
export type MessageAuthor =
  | { kind: 'user' }
  | ({ kind: 'session'; name: string; handle: string } & SessionRef)
  | { kind: 'outpost'; level: 'info' | 'warning' | 'error' }
export interface ChannelMessage {
  id: string
  channelId: string
  at: string
  author: MessageAuthor
  text: string
  /** Handles this message addressed. */
  mentions: string[]
  /** The user message that began this chain of replies, and the reply depth. */
  root: string
  hop: number
  /** The member turn that produced this reply. */
  turn: (SessionRef & { turn: string }) | null
  /** The page's key for a user post; a resent draft with it is the same post. */
  key: string | null
  /** Files the member's turn published; they stay in that session's files. */
  files: SessionFile[]
}
export type DeliverySource =
  | { kind: 'channel'; channelId: string; root: string; hop: number; through: string | null }
  /** `call`: the agent's Outpost tool call that sent it; null for a reply. */
  | { kind: 'session'; threadId: string; hop: number; from: ChannelMember; reply: boolean; call: string | null }
  | { kind: 'schedule'; scheduleId: string }
export interface Delivery extends SessionRef {
  id: string
  state: 'pending' | 'sent' | 'running' | 'done' | 'failed'
  turn: string | null
  source: DeliverySource
  /** Mentioned again while working: deliver the newer messages next, in this chain. */
  rerun: { root: string; hop: number } | null
  /** The composed prompt, kept until it is accepted so a restart can resend it. */
  prompt: string | null
  /** The chat host instance the prompt was sent to; a resend is safe only to the same one. */
  host: string | null
  origin: ChatOrigin | null
  error: string | null
  createdAt: string
  updatedAt: string
}
export interface Schedule extends SessionRef {
  id: string
  name: string
  prompt: string
  cron: string
  timeZone: string
  enabled: boolean
  createdAt: string
  lastRun: { at: string; ok: boolean; message: string | null } | null
}

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

const id = Type.String({ pattern: '^[A-Za-z0-9_-]{1,80}$' })
const uuid = Type.String({ pattern: '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$' })
const targetId = Type.String({ minLength: 1, maxLength: 80, pattern: '^[^\\u0000-\\u001f\\u007f]+$' })
const session = { targetId, sessionId: uuid }
const strict = { additionalProperties: false } as const
const text = (maxLength: number) => Type.String({ maxLength, pattern: '^[^\\u0000]*$' })
export const channelName = Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,39}$' })
const channelInput = Type.Object(
  {
    id: Type.Optional(uuid),
    name: channelName,
    topic: text(500),
    members: Type.Array(Type.Object(session, strict), { maxItems: chatLimits.members }),
  },
  strict,
)
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
    images: Type.Array(uuid, { maxItems: 8 }),
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
  message('instructions', { id, ...session, instructions: Type.Union([text(32_000), Type.Null()]) }),
  message('channel-save', { id, channel: channelInput }),
  message('channel-delete', { id, channelId: uuid }),
  message('channel-history', { id, channelId: uuid, before: Type.Union([uuid, Type.Null()]) }),
  message('channel-post', { id, channelId: uuid, key: id, text: text(chatLimits.text) }),
  message('channel-read', { channelId: uuid }),
  message('schedule-save', { id, schedule: scheduleInput }),
  message('schedule-delete', { id, scheduleId: uuid }),
  message('schedule-run', { id, scheduleId: uuid }),
  message('refresh', { id }),
  // Session creation through the chat socket, so Outpost Desktop's chat window
  // needs no browser login.
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
    instructions: Type.Union([text(32_000), Type.Null()]),
  }),
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
