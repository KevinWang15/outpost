import { useEffect, useState } from 'react'
import { CheckCircle2, LoaderCircle, ShieldCheck } from 'lucide-react'
import { validDesktopProof } from '../../shared/desktopAuth'
import { api } from '../api'
import { useAuth } from '../auth/useAuth'

export default function DesktopAuthorizePage({ requestId }: { requestId: string }) {
  const { user, signOut } = useAuth()
  const [ready, setReady] = useState(false)
  const [expectedAccount, setExpectedAccount] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ callback: string; allowed: boolean } | null>(null)
  const requestValid = validDesktopProof(requestId)
  const mismatch = expectedAccount !== null && expectedAccount !== (user?.id ?? 'local')
  const problem = requestValid
    ? error || (mismatch ? 'Sign in with the same account as the website that opened the app.' : '')
    : 'Start sign-in from Outpost Desktop to connect this server.'
  useEffect(() => {
    const controller = new AbortController()
    if (!requestValid) return
    void api<{ accountId: string | null }>(`/desktop/authorizations/${requestId}`, 'GET', undefined, controller.signal)
      .then(result => {
        if (!controller.signal.aborted) {
          setExpectedAccount(result.accountId)
          setReady(true)
        }
      })
      .catch(problem => {
        if (!controller.signal.aborted) setError(problem.message)
      })
    return () => controller.abort()
  }, [requestId, requestValid])
  async function decide(allow: boolean) {
    setBusy(true)
    setError('')
    try {
      const { callback } = await api<{ callback: string }>(`/desktop/authorizations/${requestId}`, 'POST', {
        allow,
        accountId: user?.id ?? 'local',
      })
      setResult({ callback, allowed: allow })
      window.location.assign(callback)
    } catch (problem) {
      setError((problem as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="desktop-authorization">
      <div className="auth-card">
        <img src="/outpost.svg" alt="Outpost" width="54" height="54" />
        <h1>
          {result ? (result.allowed ? 'App access approved.' : 'Sign-in cancelled.') : 'Connect Outpost Desktop?'}
        </h1>
        {result ? (
          <>
            <p>
              <CheckCircle2 size={18} />{' '}
              {result.allowed ? 'Return to the app to browse and open your sessions.' : 'No app access was granted.'}
            </p>
            <a className="button" href={result.callback}>
              Return to Outpost Desktop
            </a>
            <p className="hint">You can close this browser tab.</p>
          </>
        ) : (
          <>
            <p>
              <strong>{window.location.origin}</strong>
            </p>
            <p>
              Signed in as <strong>{user ? `${user.name} (${user.email})` : 'Local workspace'}</strong>.
            </p>
            <p>
              The app will be able to list, create and open your terminal sessions on this server for 30 days. You can
              sign out in the app at any time.
            </p>
            <p>
              <ShieldCheck size={18} /> Only approve this if you started sign-in in Outpost Desktop.
            </p>
            {user && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void signOut().catch(error => setError(error.message))}
              >
                Use another account
              </button>
            )}
            {ready && (
              <div className="authorization-actions">
                <button className="button secondary" disabled={busy} onClick={() => void decide(false)}>
                  Cancel
                </button>
                <button className="button" disabled={busy || mismatch} onClick={() => void decide(true)}>
                  {busy ? <LoaderCircle className="loading-spinner" /> : null} Connect app
                </button>
              </div>
            )}
            {!ready && !problem && <p role="status">Loading sign-in request…</p>}
          </>
        )}
        {problem && (
          <p role="alert" className="error-text">
            {problem}
          </p>
        )}
      </div>
    </main>
  )
}
