import type { CloseReason } from '../../shared/protocol'

export type TerminalState =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting'; attempt: number; message: string }
  | { kind: 'closed'; reason: CloseReason; message: string }
