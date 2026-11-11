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
  nativeTitle?: string
  managedSessionId?: string
}
export interface HistoryCheckpoint {
  offset: number
  size: number
  modified: string
  generation: string
  prefix: string
  prefixSize: number
  tail: string
  tailSize: number
}
export interface HistoryMessage {
  position: number
  role: 'user' | 'assistant' | 'tool'
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
