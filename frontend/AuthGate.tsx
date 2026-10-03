import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import type { AuthState } from '../shared/auth'
import { api } from './api'
import { AuthContext } from './useAuth'
import AuthPage from './AuthPage'

export default function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null)
  const [error, setError] = useState('')
  const [path, setPath] = useState(window.location.pathname)
  const generation = useRef(0)
  const channel = useRef<BroadcastChannel | null>(null)
  const navigate = useCallback((destination: string) => {
    window.history.pushState(null, '', destination)
    setPath(new URL(destination, window.location.href).pathname)
  }, [])
  const load = useCallback(async (signal?: AbortSignal, broadcast = false) => {
    const version = ++generation.current
    const next = await api<AuthState>('/auth/session', 'GET', undefined, signal)
    if (!['local', 'hosted'].includes(next.mode)) throw new Error('Could not load account settings.')
    if (version === generation.current && !signal?.aborted) { setState(next); setError('') }
    if (broadcast) channel.current?.postMessage('changed')
    return next
  }, [])
  const refresh = useCallback(() => load(undefined, true), [load])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal).catch(problem => { if (!controller.signal.aborted) setError(problem.message) })
    return () => controller.abort()
  }, [load])
  useEffect(() => {
    const changed = () => setPath(window.location.pathname)
    window.addEventListener('popstate', changed)
    return () => window.removeEventListener('popstate', changed)
  }, [])
  useEffect(() => {
    if (state?.mode !== 'hosted') return
    const expired = () => { generation.current++; setState({ mode: 'hosted', user: null }); navigate('/login') }
    const reload = () => { void load().catch(() => {}) }
    const broadcast = typeof BroadcastChannel === 'function' ? new BroadcastChannel('outpost-accounts') : null
    channel.current = broadcast
    if (broadcast) broadcast.onmessage = reload
    window.addEventListener('outpost:unauthorized', expired)
    window.addEventListener('focus', reload)
    return () => { broadcast?.close(); channel.current = null; window.removeEventListener('outpost:unauthorized', expired); window.removeEventListener('focus', reload) }
  }, [state?.mode, load, navigate])
  async function signOut() {
    await api('/auth/logout', 'POST')
    generation.current++
    setState({ mode: 'hosted', user: null })
    channel.current?.postMessage('changed')
    navigate('/login')
  }
  if (!state) return <div className="auth-loading" role="status">
    <img src="/outpost.svg" width="54" height="54" alt="Outpost" />
    {error ? <><p role="alert">{error}</p><button className="button secondary" onClick={() => { setError(''); void load().catch(problem => setError(problem.message)) }}><RefreshCw /> Try again</button></> : <><LoaderCircle className="loading-spinner" /><p>Opening your workspace…</p></>}
  </div>
  const authRoute = ['/signup', '/verify-email', '/forgot-password', '/reset-password'].includes(path)
  return <AuthContext.Provider value={{ ...state, refresh, signOut, navigate }}>
    {state.mode === 'local' || (state.user && !authRoute) ? <div key={state.user?.id ?? 'local'} className="account-workspace">{children}</div> : <AuthPage key={`${path}:${window.location.search}`} path={path} />}
  </AuthContext.Provider>
}
