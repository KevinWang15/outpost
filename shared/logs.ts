// Outpost's activity log: what happened across an account's machines and
// sessions, shown in the log viewer and sent to webhooks. The event shape is
// the webhook payload, so it is versioned and only ever gains optional fields.
import Type, { type Static } from 'typebox'
import { name } from './schemas'

export const logKinds = [
  'agent',
  'message',
  'session',
  'machine',
  'channel',
  'schedule',
  'terminal',
  'webhook',
] as const
export type LogKind = (typeof logKinds)[number]
export const logLevels = ['info', 'warning', 'error'] as const
export type LogLevel = (typeof logLevels)[number]

export const logKindLabels: Record<LogKind, string> = {
  agent: 'Agent status',
  message: 'Messages',
  session: 'Sessions',
  machine: 'Machines',
  channel: 'Channels',
  schedule: 'Schedules',
  terminal: 'Terminals',
  webhook: 'Webhooks',
}

export interface LogEvent {
  id: string
  /** ISO 8601; for what a machine recorded, when it happened there. */
  time: string
  level: LogLevel
  kind: LogKind
  /** What happened within the kind, e.g. `status`, `delivered`, `created`. */
  type: string
  /** One sentence, as the viewer shows it. */
  message: string
  machine: { id: string; name: string } | null
  session: { id: string; name: string } | null
  /** Facts for filtering and automation, e.g. `state`, `channel`, `error`. */
  details: Record<string, string | number | boolean | null>
}
/** The body of every webhook request. */
export interface WebhookPayload {
  version: 1
  webhook: { id: string; name: string }
  event: LogEvent
}

// Webhooks ------------------------------------------------------------------------

/** Header names Outpost sets itself or that HTTP reserves. */
export const reservedHeaders = [
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'user-agent',
]
const headerName = Type.String({ minLength: 1, maxLength: 100, pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$" })
const headerValue = Type.String({ maxLength: 4096, pattern: '^[^\\u0000-\\u001f\\u007f]*$' })
const url = Type.String({ minLength: 8, maxLength: 2048, pattern: '^https?://[^\\s\\u0000-\\u001f\\u007f]+$' })
const kinds = Type.Array(Type.Enum(logKinds), { maxItems: logKinds.length, uniqueItems: true })

export const webhookInput = Type.Object(
  {
    name,
    url,
    /** Without `value`, a header keeps the value saved before (values are never sent back). */
    headers: Type.Array(
      Type.Object({ name: headerName, value: Type.Optional(headerValue) }, { additionalProperties: false }),
      {
        maxItems: 16,
      },
    ),
    /** Empty sends every kind. */
    kinds,
    /** The lowest level sent. */
    level: Type.Enum(logLevels),
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
)
export type WebhookInput = Static<typeof webhookInput>

export interface WebhookDelivery {
  at: string
  ok: boolean
  /** The HTTP status, when there was a response. */
  status: number | null
  error: string | null
}
/** A webhook as the owner sees it: header values stay on the server. */
export interface Webhook {
  id: string
  name: string
  url: string
  headers: { name: string }[]
  kinds: LogKind[]
  level: LogLevel
  enabled: boolean
  createdAt: string
  lastDelivery: WebhookDelivery | null
}

/** Where the log viewer shows the account's activity. */
export interface LogView {
  /** The viewer's mount path. */
  path: string
  channel: string
}
