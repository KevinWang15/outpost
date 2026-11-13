import type { HarnessId } from './harnesses'
export type HistoryMode = 'keyword' | 'substring' | 'semantic' | 'hybrid' | 'mixed'

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
  format?: string
  /** The native conversation this one was forked from, where the tool records it. */
  forkedFrom?: string | null
  nativeTitle?: string
  managedSessionId?: string
}
export interface HistoryCheckpoint {
  offset: number
  size: number
  /** Physical source size when positions refer to a decoded stream. */
  sourceSize?: number
  modified: string
  generation: string
  prefix: string
  prefixSize: number
  tail: string
  tailSize: number
  /** The identity of the last message read, which the next one's may derive from. */
  identity?: string | null
}
export interface HistoryMessage {
  position: number
  /** Logical identity: the tool's message ID where it has one, otherwise derived
   * from the message and the one before it. Copies of a message in forks share it. */
  identity: string
  role: 'user' | 'assistant' | 'tool'
  /** `summary` replaces the messages before it (a compaction). */
  kind: string
  text: string
  timestamp: string | null
  turnId: string | null
  truncated: boolean
  totalChars?: number
  contentHash?: string
}
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
