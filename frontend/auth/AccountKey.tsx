import { useEffect, useState } from 'react'
import { KeyRound, RefreshCw } from 'lucide-react'
import type { AccountSshKey } from '../../shared/auth'
import { api } from '../api'
import { CopyField } from '../ui/CopyField'

/** The account's public key, to authorize on each server (hosted mode). */
export default function AccountKey() {
  const [key, setKey] = useState<AccountSshKey | null>(null)
  const [error, setError] = useState(''),
    [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    api<AccountSshKey>('/account/ssh-key', 'GET', undefined, controller.signal).then(setKey, problem => {
      if (!controller.signal.aborted) setError(problem.message)
    })
    return () => controller.abort()
  }, [attempt])
  return (
    <section className="account-key" aria-label="Your Outpost SSH key">
      <h3>
        <KeyRound size={16} />
        Authorize your Outpost key
      </h3>
      <p>
        Add this public key to <code>/root/.ssh/authorized_keys</code> on the server. Outpost uses it for sessions and
        terminals.
      </p>
      {key ? (
        <>
          <CopyField value={key.publicKey} label="Public key" />
          <small className="muted">{key.fingerprint}</small>
        </>
      ) : error ? (
        <p className="error" role="alert">
          {error}{' '}
          <button
            className="link"
            onClick={() => {
              setError('')
              setAttempt(value => value + 1)
            }}
          >
            <RefreshCw size={12} />
            Retry
          </button>
        </p>
      ) : (
        <p className="muted" role="status">
          Preparing your key…
        </p>
      )}
    </section>
  )
}
