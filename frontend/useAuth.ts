import { createContext, useContext } from 'react'
import type { AuthState } from '../shared/auth'

interface AuthContextValue extends AuthState {
  refresh: () => Promise<AuthState>
  signOut: () => Promise<void>
  navigate: (path: string) => void
}
export const AuthContext = createContext<AuthContextValue | null>(null)
export function useAuth() {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error('useAuth requires AuthGate.')
  return auth
}
