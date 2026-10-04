import { createContext, useContext } from 'react'
import type { AuthState } from '../shared/auth'

interface AuthContextValue extends AuthState {
  refresh: () => Promise<AuthState>
  signOut: () => Promise<void>
  navigate: (path: string) => void
}
export const AuthContext = createContext<AuthContextValue>({
  mode: 'local', user: null,
  refresh: async () => ({ mode: 'local', user: null }),
  signOut: async () => {}, navigate: path => { window.location.href = path },
})
export const useAuth = () => useContext(AuthContext)
