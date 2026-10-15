// Terminal protocol between clients (web terminal and desktop app) and the
// broker. Binary WebSocket frames carry raw terminal bytes; text frames carry
// these JSON messages. See docs/ARCHITECTURE.md → "Terminal protocol".
import type { Static } from 'typebox'
import type { ImageMediaType } from './model'
import type { connectInput, historyNavigation } from './schemas'

// Clients send ?protocol=<version>. The server accepts only its own version and
// closes others with `outdated`. Only the current protocol is supported;
// a stale terminal page must reload after a breaking server update.
export const protocolVersion = 3
export const maxInputMessage = 64 * 1024

export type HistoryNavigation = Static<typeof historyNavigation>
export type HistoryAction = keyof HistoryNavigation['keys']

export interface ScrollbackState {
  available: boolean
  lines: number
  offset: number
  rows: number
  active: boolean
  alternate: boolean
  navigation?: HistoryNavigation
}

export type ClientMessage =
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ack'; bytes: number }
  | { type: 'send'; id: string; data: string }
  | { type: 'paste-image'; id: string; mediaType: ImageMediaType; data: string }
  // No offset subscribes to metadata; 0 returns live, -1 seeks the oldest line.
  // Every seek publishes metadata, then its result, before later input.
  | { type: 'scrollback'; offset?: undefined; id?: undefined }
  | { type: 'scrollback'; offset: number; id: string }

export type CloseReason = 'detached' | 'ended' | 'expired' | 'outdated' | 'error'
export interface SignalMessage {
  type: string
  payload: unknown
}
export type ServerMessage =
  | { type: 'hello'; resume: string; session: { id: string; name: string }; target: { id: string; name: string } }
  | { type: 'ready' }
  | ({ type: 'scrollback' } & ScrollbackState)
  | { type: 'result'; id: string; ok: boolean; message?: string; reference?: string }
  | { type: 'signal'; signal: SignalMessage }
  | { type: 'closed'; reason: CloseReason; message: string }

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
