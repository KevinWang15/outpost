import type { CloseReason } from '../../shared/protocol'

export type TerminalState =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting'; attempt: number; message: string }
  | { kind: 'closed'; reason: CloseReason; message: string }

/** The terminal screen owns presentation; a connection owns delivery and lifecycle. */
export interface TerminalConnection {
  readonly connected: boolean
  open(): void
  reconnect(): void
  close(): void
  fail(message: string): void
  input(data: string | Uint8Array<ArrayBuffer>): boolean
  resize(cols: number, rows: number): void
  setActive?(active: boolean): void
  submit(data: string): Promise<void>
  clear(): Promise<void>
  pasteImage(file: File): Promise<string>
  resume?(): void
  networkChanged?(online: boolean): void
  activate?(token: string): Promise<void>
  acknowledge?(completionId: string): Promise<void>
}
