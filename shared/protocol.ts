// Terminal protocol between clients (web terminal, native connector) and the
// broker. Binary WebSocket frames carry raw terminal bytes; text frames carry
// these JSON messages. See docs/ARCHITECTURE.md → "Terminal protocol".
import type { ImageMediaType } from './model'
import type { TerminalChoice } from './terminals'

export const protocolVersion = 2
export const maxInputMessage = 64 * 1024

export type ClientMessage =
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ack'; bytes: number }
  | { type: 'send'; id: string; data: string }
  | { type: 'paste-image'; id: string; mediaType: ImageMediaType; data: string }

export type CloseReason = 'detached' | 'ended' | 'expired' | 'error'
export interface SignalMessage { type: string; payload: unknown }
export type ServerMessage =
  | { type: 'hello'; resume: string; session: { id: string; name: string }; target: { id: string; name: string } }
  | { type: 'ready' }
  | { type: 'result'; id: string; ok: boolean; message?: string; reference?: string }
  | { type: 'signal'; signal: SignalMessage }
  | { type: 'closed'; reason: CloseReason; message: string }

export interface ConnectRequest { terminal: TerminalChoice }
export interface ConnectResponse { id: string; token: string; expiresAt: string; url: string | null }
export interface ConnectionStatus { status: 'pending' | 'connected' }
