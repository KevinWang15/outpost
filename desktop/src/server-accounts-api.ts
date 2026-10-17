import type { DesktopLogin } from '../../shared/desktopAuth'

export type ServerConnection = 'checking' | 'connected' | 'offline' | 'expired' | 'signing-out'
/** Only saved logins appear in this list. No trust data or credentials cross IPC. */
export interface ServerAccountSummary extends DesktopLogin {
  origin: string
  status: ServerConnection
  error: string | null
}
export type SignInPhase = 'opening' | 'waiting' | 'exchanging' | 'saving'
/** Transient form progress, separate from the durable account list. */
export interface ServerSignInSummary {
  origin: string
  phase: SignInPhase
}
export interface ServerAccountsSnapshot {
  accounts: ServerAccountSummary[]
  signIns: ServerSignInSummary[]
}
