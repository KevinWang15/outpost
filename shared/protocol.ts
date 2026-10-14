// Terminal protocol between clients (web terminal, native connector) and the
// broker. Binary WebSocket frames carry raw terminal bytes; text frames carry
// these JSON messages. See docs/ARCHITECTURE.md → "Terminal protocol".
import type { Static } from 'typebox'
import type { ImageMediaType } from './model'
import type { connectInput, historyNavigation } from './schemas'

// Clients send ?protocol=<version>. The server accepts only its own version and
// closes others with `outdated`. Bump it for changes old clients would misread;
// additive fields that old clients ignore keep the version.
export const protocolVersion = 2
export const maxInputMessage = 64 * 1024

export type HistoryNavigation = Static<typeof historyNavigation>
export type HistoryAction = keyof HistoryNavigation['keys']

export interface ScrollbackState {
  available: boolean
  lines: number
  offset: number
  rows: number
  active: boolean
  alternate?: boolean
  navigation?: HistoryNavigation
}

export type ClientMessage =
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ack'; bytes: number }
  | { type: 'send'; id: string; data: string }
  | { type: 'paste-image'; id: string; mediaType: ImageMediaType; data: string }
  // No offset subscribes to metadata; 0 returns live, -1 seeks the oldest line.
  // An identified seek publishes metadata, then a result, before later input.
  | { type: 'scrollback'; offset?: number; id?: string }

export const closeReasons = ['detached', 'ended', 'expired', 'outdated', 'error'] as const
export type CloseReason = (typeof closeReasons)[number]
export interface SignalMessage {
  type: string
  payload: unknown
}
export type ServerMessage =
  | { type: 'hello'; resume: string; session: { id: string; name: string }; target: { id: string; name: string } }
  | { type: 'ready'; scrollback?: boolean }
  | ({ type: 'scrollback' } & ScrollbackState)
  | { type: 'result'; id: string; ok: boolean; message?: string; reference?: string }
  | { type: 'signal'; signal: SignalMessage }
  | { type: 'closed'; reason: CloseReason; message: string }

// Runtime list for clients in other languages (tests/unit/contracts.test.ts);
// the alias below fails to compile if it misses a ServerMessage type.
export const serverMessageTypes = ['hello', 'ready', 'result', 'signal', 'scrollback', 'closed'] as const
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T
export type ServerMessageTypesCovered = Assert<Same<ServerMessage['type'], (typeof serverMessageTypes)[number]>>

export type ConnectRequest = Static<typeof connectInput>
export interface ConnectResponse {
  id: string
  token: string
  expiresAt: string
  url: string | null
}
export interface ConnectionStatus {
  status: 'pending' | 'connected'
}
