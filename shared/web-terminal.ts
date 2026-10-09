import type { AccountSshKey } from './auth'

export interface TerminalKeyInfo { fingerprint: string; type: string; uploadedAt: string; hostFingerprint: string | null }
export type TerminalKeySource = 'account' | 'uploaded'
export interface TerminalKeyStatus { encryptionAvailable: boolean; key: TerminalKeyInfo | null; accountKey?: AccountSshKey; keyError?: string }
export interface WebTerminalInfo { id: string; cols: number; rows: number; reconnectSeconds: number }
export type TerminalClientMessage = { type: 'input'; data: string; id?: string } | { type: 'resize'; cols: number; rows: number } | { type: 'ack'; bytes: number }
export type TerminalInputResult = { type: 'input-result'; id: string } & ({ accepted: true } | { accepted: false; message: string })
export type TerminalServerMessage = { type: 'snapshot'; data: string; cols: number; rows: number } | { type: 'closed'; message: string } | TerminalInputResult
