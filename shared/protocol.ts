// Terminal protocol between clients (web terminal and desktop app) and the
// broker. Binary WebSocket frames carry raw terminal bytes; text frames carry
// these JSON messages. See docs/ARCHITECTURE.md → "Terminal protocol".
import type { Static } from 'typebox'
import type { SessionActivity } from './activity'
import type { connectInput } from './schemas'
import type { Checkpoint } from './terminalState'

// Clients send ?protocol=<version>. The server accepts only its own version and
// closes others with `outdated`. Only the current protocol is supported;
// a stale terminal page must reload after a breaking server update.
export const protocolVersion = 13
export const maxInputMessage = 64 * 1024
// Interactive input only; binary image uploads use a separate HTTP request.
export const maxInputQueue = 2 * 1024 * 1024
export const terminalConnectionPolicy = {
  attachMs: 60_000,
  clientAttachMs: 75_000,
  heartbeatMs: 15_000,
  probeMs: 30_000,
  wakeProbeMs: 5_000,
  retryMaxMs: 30_000,
  stableMs: 30_000,
  inputStallMs: 30_000,
  outputStallMs: 60_000,
} as const

export type ClientMessage =
  | { type: 'ping'; id: string }
  | { type: 'activate'; id: string; token: string }
  | { type: 'acknowledge'; id: string; completionId: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'focus'; active: boolean }
  | { type: 'ack'; bytes: number }
  | { type: 'send'; id: string; data: string }
  | { type: 'paste'; id: string; data: string }
  | { type: 'clear'; id: string }

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
  | { type: 'clear' }
  | { type: 'activity'; activity: SessionActivity }
  | { type: 'result'; id: string; ok: boolean; message?: string }
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
