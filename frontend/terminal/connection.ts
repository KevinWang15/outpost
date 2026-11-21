import type { CloseReason, TerminalRoute } from '../../shared/protocol'

export type TerminalState =
  | { kind: 'connecting' }
  | { kind: 'connected'; route: TerminalRoute }
  | { kind: 'reconnecting'; attempt: number; message: string }
  | { kind: 'closed'; reason: CloseReason; message: string }
