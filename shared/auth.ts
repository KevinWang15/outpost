export interface AccountUser {
  id: string
  name: string
  email: string
  emailVerifiedAt: string | null
  createdAt: string
}
export interface AuthState { mode: 'local' | 'hosted'; user: AccountUser | null }
export interface AuthMessage { message: string; email?: string; devUrl?: string }
export interface AccountSshKey { publicKey: string; fingerprint: string }
