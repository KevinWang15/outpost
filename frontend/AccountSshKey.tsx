import { useEffect, useState } from 'react'
import { Check, Copy, KeyRound, RefreshCw } from 'lucide-react'
import type { AccountSshKey as SshKey } from '../shared/auth'
import { api } from './api'

export default function AccountSshKey() {
  const [key, setKey] = useState<SshKey | null>(null)
  const [error, setError] = useState(''), [copied, setCopied] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    api<SshKey>('/account/ssh-key', 'GET', undefined, controller.signal).then(setKey).catch(problem => {
      if (!controller.signal.aborted) setError(problem.message)
    })
    return () => controller.abort()
  }, [attempt])
  async function copy() {
    try { await navigator.clipboard.writeText(key!.publicKey); setCopied(true); setError('') }
    catch { setError('Clipboard unavailable. Select and copy the public key below.') }
  }
  return <section className="account-key" aria-label="Your SSH public key">
    <h3><KeyRound size={18} /> Authorize your Outpost SSH key</h3>
    <p>Add this public key to <code>/root/.ssh/authorized_keys</code> on each development server you connect. Outpost uses this account's key to manage sessions, check software, and open web terminals.</p>
    {key ? <><pre tabIndex={0}>{key.publicKey}</pre><div className="account-key-actions"><code>{key.fingerprint}</code><button className="button secondary" type="button" onClick={copy}>{copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy public key'}</button></div></> : !error && <p role="status">Preparing your public key…</p>}
    {error && <div role="alert"><p className="error">{error}</p>{!key && <button className="button secondary" type="button" onClick={() => { setError(''); setAttempt(value => value + 1) }}><RefreshCw /> Retry</button>}</div>}
    <small>For browser or phone access, click Connect using web terminal beside a session. Your authorized Outpost key is used automatically. Copied connection commands use your computer’s SSH credentials.</small>
  </section>
}
