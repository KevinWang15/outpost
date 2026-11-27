import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import type { AuthState } from '../../shared/auth'
import { isProtectedWorkspacePath, pagePaths } from '../../shared/pages'
import { api } from '../api'
import { navigate as routerNavigate, useLocation } from '../router'
import { clearWorkspaceCache } from '../workspace/cache'
import AuthPage from './AuthPage'
import { desktopReturnPath } from './returnPath'
import { AuthContext } from './useAuth'

export default function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null)
  const [error, setError] = useState('')
  const { pathname: path, search } = useLocation()
  const generation = useRef(0)
  const channel = useRef<BroadcastChannel | null>(null)
  const returnTo = useRef(
    desktopReturnPath(window.location.pathname + window.location.search) ??
      desktopReturnPath(new URLSearchParams(window.location.search).get('returnTo')),
  )
  const entry = useRef(
    isProtectedWorkspacePath(window.location.pathname)
      ? window.location.pathname + window.location.search + window.location.hash
      : pagePaths.workspace,
  )
  const navigate = useCallback((destination: string) => {
    if (destination === pagePaths.workspace) {
      routerNavigate(returnTo.current ?? entry.current, { replace: true })
      return
    }
    if (returnTo.current) {
      const url = new URL(destination, window.location.origin)
      url.searchParams.set('returnTo', returnTo.current)
      destination = url.pathname + url.search
    }
    routerNavigate(destination, { transition: false })
  }, [])
  const load = useCallback(async (signal?: AbortSignal, broadcast = false) => {
    const version = ++generation.current
    const next = await api<AuthState>('/auth/session', 'GET', undefined, signal)
    if (!['local', 'hosted'].includes(next.mode)) throw new Error('Could not load account settings.')
    if (version === generation.current && !signal?.aborted) {
      setState(next)
      setError('')
    }
    if (broadcast) channel.current?.postMessage('changed')
    return next
  }, [])
  const refresh = useCallback(() => load(undefined, true), [load])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal).catch(problem => {
      if (!controller.signal.aborted) setError(problem.message)
    })
    return () => controller.abort()
  }, [load])
  useEffect(() => {
    if (state?.mode !== 'hosted') return
    const expired = () => {
      generation.current++
      clearWorkspaceCache()
      setState({ mode: 'hosted', user: null })
      navigate(pagePaths.login)
    }
    const reload = () => {
      void load().catch(() => {})
    }
    const broadcast = typeof BroadcastChannel === 'function' ? new BroadcastChannel('outpost-accounts') : null
    channel.current = broadcast
    if (broadcast) broadcast.onmessage = reload
    window.addEventListener('outpost:unauthorized', expired)
    window.addEventListener('focus', reload)
    return () => {
      broadcast?.close()
      channel.current = null
      window.removeEventListener('outpost:unauthorized', expired)
      window.removeEventListener('focus', reload)
    }
  }, [state?.mode, load, navigate])
  async function signOut() {
    await api('/auth/logout', 'POST')
    entry.current = pagePaths.workspace
    returnTo.current = null
    generation.current++
    clearWorkspaceCache()
    setState({ mode: 'hosted', user: null })
    channel.current?.postMessage('changed')
    navigate(pagePaths.login)
  }
  if (!state)
    return (
      <div className="auth-loading" role="status">
        <img src="/outpost.svg" width="54" height="54" alt="Outpost" />
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button
              className="button"
              onClick={() => {
                setError('')
                void load().catch(problem => setError(problem.message))
              }}
            >
              <RefreshCw size={15} aria-hidden="true" /> Try again
            </button>
          </>
        ) : (
          <>
            <LoaderCircle className="spin" />
            <p>Opening your workspace…</p>
          </>
        )}
      </div>
    )
  const authRoute = [pagePaths.signup, pagePaths.verifyEmail, pagePaths.forgotPassword, pagePaths.resetPassword].some(
    route => route === path,
  )
  return (
    <AuthContext.Provider value={{ ...state, refresh, signOut, navigate }}>
      {state.mode === 'local' || (state.user && !authRoute) ? (
        <div key={state.user?.id ?? 'local'} className="account-workspace">
          {children}
        </div>
      ) : (
        <AuthPage key={`${path}:${search}`} path={path} />
      )}
    </AuthContext.Provider>
  )
}
