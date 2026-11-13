// The node protocol: everything between the Outpost server and one machine,
// over the single connection the server keeps to it (docs/ARCHITECTURE.md,
// "Machines"). Frames are length-prefixed, as everywhere in Outpost:
//   C  control message (JSON)
//   D  stream data: a 4-byte stream number, then bytes

import type { ActivityState } from './activity'

export const machineProtocol = 2
/** Printed by the node before its first frame; login shells may print before it. */
export const nodeMagic = '\0OUTPOST-NODE-1\0'
/** Bytes a stream may send before the receiver grants more. */
export const streamWindow = 4 * 1024 * 1024

export type StreamKind = 'terminal' | 'chat' | 'file-read' | 'file-receive' | 'image'

export interface RemoteError {
  message: string
  status: number
}

export type MachineMessage =
  /** node → server, once, before anything else. */
  | { type: 'hello'; version: string; protocol: number; pid: number }
  | { type: 'call'; id: string; op: string; args: unknown }
  | { type: 'result'; id: string; ok: true; data: unknown }
  | { type: 'result'; id: string; ok: false; error: RemoteError }
  /** server → node: open a stream; the node answers `opened` or `close`. */
  | { type: 'open'; stream: number; kind: StreamKind; args: unknown }
  | { type: 'opened'; stream: number; data: unknown }
  /** Either side ends a stream. A receiver's final answer travels with it. */
  | { type: 'close'; stream: number; error?: RemoteError; data?: unknown }
  | { type: 'credit'; stream: number; bytes: number }
  /** node → server: the machine's event log grew; read it with the `events` call. */
  | { type: 'events' }

/** What sessions' drivers did on a machine, from its event log (machine/events.ts). */
export type MachineEvent =
  | {
      type: 'activity'
      at: string
      session: string
      state: ActivityState
      previous: ActivityState | null
      detail: string | null
    }
  | { type: 'started'; at: string; session: string; driver: 'terminal' | 'chat' }
  /** `code` is the tool's exit status; null when Outpost stopped it. */
  | { type: 'exited'; at: string; session: string; driver: 'terminal' | 'chat'; code: number | null }
/** Events after a cursor; `cursor` continues from the last one returned. */
export interface MachineEvents {
  events: MachineEvent[]
  cursor: string
  more: boolean
}

/** An Outpost MCP tool call an agent made on this machine, answered by the server. */
export interface AgentCall {
  session: string
  tool: string
  arguments: Record<string, unknown>
}

export interface TerminalStreamArgs {
  session: string
  cols: number
  rows: number
  start: boolean
}
export interface ChatStreamArgs {
  session: string
  start: boolean
}
export interface FileReadArgs {
  session: string
  file: string
}
export interface FileReceiveArgs {
  session: string
  name: string
  size: number
}
export interface ImageArgs {
  session: string
  extension: string
  size: number
}
