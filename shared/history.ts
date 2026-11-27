import Type, { type Static } from 'typebox'
import type { HarnessId } from './harnesses'
type HistoryMode = 'keyword' | 'substring' | 'semantic' | 'mixed'

export interface HistoryMachine {
  id: string
  name: string
  host: string
}
export interface HistorySource {
  id: string
  tool: HarnessId
  nativeId: string
  home: string
  path: string
  title: string
  cwd: string
  size: number
  modified: string
  /** The native conversation this one was forked from, where the tool records it. */
  forkedFrom: string | null
  managedSessionId: string | null
}
const count = Type.Integer({ minimum: 0 })
const nullableText = Type.Union([Type.String(), Type.Null()])
export const historyCheckpoint = Type.Object(
  {
    offset: count,
    size: count,
    /** Physical source size, including when positions refer to a decoded stream. */
    sourceSize: count,
    modified: Type.String(),
    generation: Type.String(),
    prefix: Type.String(),
    prefixSize: count,
    tail: Type.String(),
    tailSize: count,
    /** The identity of the last message read, which the next one's may derive from. */
    identity: nullableText,
  },
  { additionalProperties: false },
)
export type HistoryCheckpoint = Static<typeof historyCheckpoint>
export const historyMessage = Type.Object(
  {
    position: count,
    /** Logical identity: the tool's message ID where it has one, otherwise derived
     * from the message and the one before it. Copies of a message in forks share it. */
    identity: Type.String(),
    role: Type.Enum(['user', 'assistant', 'tool']),
    /** `summary` replaces the messages before it (a compaction). */
    kind: Type.String(),
    text: Type.String(),
    timestamp: nullableText,
    turnId: nullableText,
    truncated: Type.Boolean(),
    totalChars: count,
    contentHash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  },
  { additionalProperties: false },
)
type HistoryMessage = Static<typeof historyMessage>
export interface HistoryCatalog {
  sources: HistorySource[]
  next: string | null
  warnings: string[]
}
export interface HistoryBatch {
  files: {
    source: HistorySource
    checkpoint: HistoryCheckpoint
    reset: boolean
    messages: HistoryMessage[]
    pending: boolean
  }[]
  warnings: string[]
}
export interface HistorySearchInput {
  query: string
  mode?: HistoryMode
  machine?: string
  tool?: HarnessId
  sessionId?: string
  cwd?: string
  role?: 'user' | 'assistant' | 'tool'
  after?: string
  before?: string
  limit?: number
  offset?: number
  groupBy?: 'session' | 'message'
  sort?: 'relevance' | 'newest' | 'oldest'
  minSimilarity?: number
}

/** History offsets count Unicode code points. Keep just the requested slice of a large native record. */
export function historyMessagePage(text: string, offset: number, limit: number) {
  let start = text.length,
    end = text.length,
    index = 0,
    totalChars = 0
  for (const character of text) {
    if (totalChars === offset) start = index
    if (totalChars === offset + limit) end = index
    index += character.length
    totalChars++
  }
  return { text: text.slice(start, end), totalChars, nextOffset: offset + limit < totalChars ? offset + limit : null }
}
