// Terminal protocol between clients (web terminal and desktop app) and the
// broker. Binary WebSocket frames carry raw terminal bytes; text frames carry
// these JSON messages. See docs/ARCHITECTURE.md → "Terminal protocol".
import type { Static } from 'typebox'
import type { SessionActivity } from './activity'
import type { ImageMediaType } from './model'
import type { connectInput } from './schemas'
import type { Checkpoint } from './terminalState'

// Clients send ?protocol=<version>. The server accepts only its own version and
// closes others with `outdated`. Only the current protocol is supported;
// a stale terminal page must reload after a breaking server update.
export const protocolVersion = 10
export const maxInputMessage = 64 * 1024

export type ClientMessage =
  | { type: 'ping'; id: string }
  | { type: 'activate'; id: string; token: string }
  | { type: 'acknowledge'; id: string; completionId: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'focus'; active: boolean }
  | { type: 'ack'; bytes: number }
  | { type: 'send'; id: string; data: string }
  | { type: 'paste-image'; id: string; mediaType: ImageMediaType; data: string }

// Only `error` is transient. Other reasons require an explicit user action.
export type CloseReason = 'ended' | 'expired' | 'outdated' | 'unavailable' | 'error'
export interface SignalMessage {
  type: string
  payload: unknown
}
export type ServerMessage =
  | { type: 'hello'; resume: string; session: { id: string; name: string }; target: { id: string; name: string } }
  | { type: 'ready' }
  | { type: 'restore'; checkpoint: Checkpoint }
  | { type: 'geometry'; cols: number; rows: number }
  | { type: 'activity'; activity: SessionActivity }
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
