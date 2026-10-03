import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyRound, LoaderCircle } from 'lucide-react'
import type { Session, Target } from '../shared/session-manager'
import type { TerminalKeyStatus, WebTerminalInfo } from '../shared/web-terminal'
import { api, ApiError } from './api'
import { Modal } from './ui'
import WebTerminal from './WebTerminal'

export default function WebTerminalModal({ target, session, onClose }: { target: Target; session: Session; onClose: () => void }) {
  const base = `/targets/${target.id}`
  const [status, setStatus] = useState<TerminalKeyStatus | null>(null)
  const [terminal, setTerminal] = useState<WebTerminalInfo | null>(null)
  const [manageKey, setManageKey] = useState(false)
  const [keyProblem, setKeyProblem] = useState(false)
  const [privateKey, setPrivateKey] = useState(''), [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(true), [error, setError] = useState('')
  const alive = useRef(true), terminalId = useRef<string | null>(null)
  const launch = useCallback(async () => {
    setBusy(true); setError('')
    try {
      const info = await api<WebTerminalInfo>(`${base}/sessions/${session.id}/web-terminal`, 'POST', { cols: 80, rows: 24 })
      if (!alive.current) { void api(`/web-terminals/${info.id}`, 'DELETE').catch(() => {}); return }
      terminalId.current = info.id; setTerminal(info); setManageKey(false)
    } catch (error) { if (alive.current) setError((error as Error).message) }
    finally { if (alive.current) setBusy(false) }
  }, [base, session.id])
  useEffect(() => {
    alive.current = true
    void api<TerminalKeyStatus>(`${base}/terminal-key`).then(info => {
      if (!alive.current) return
      setStatus(info)
      if (info.key) void launch()
      else setBusy(false)
    }, error => {
      if (!alive.current) return
      setError(error.message); setBusy(false)
      // An unreadable saved key can still be removed or replaced through the UI.
      if (error instanceof ApiError && error.status === 409) { setStatus({ encryptionAvailable: true, key: null }); setKeyProblem(true) }
    })
    return () => {
      alive.current = false
      if (terminalId.current) void api(`/web-terminals/${terminalId.current}`, 'DELETE').catch(() => {})
    }
  }, [base, launch])
  async function saveKey(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const info = await api<TerminalKeyStatus>(`${base}/terminal-key`, 'PUT', { privateKey, passphrase })
      if (!alive.current) return
      setStatus(info); setKeyProblem(false); setPrivateKey(''); setPassphrase(''); terminalId.current = null; setTerminal(null)
      await launch()
    } catch (error) { if (alive.current) { setError((error as Error).message); setBusy(false) } }
  }
  async function removeKey() {
    setBusy(true); setError('')
    try {
      await api(`${base}/terminal-key`, 'DELETE')
      terminalId.current = null; setTerminal(null); setStatus(current => current && { ...current, key: null }); setManageKey(true); setKeyProblem(false); setPrivateKey(''); setPassphrase('')
    } catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }
  async function close() {
    setBusy(true)
    try {
      if (terminalId.current) await api(`/web-terminals/${terminalId.current}`, 'DELETE').catch(error => { if (error.status !== 404) throw error })
      terminalId.current = null; onClose()
    } catch (error) { setError((error as Error).message); setBusy(false) }
  }
  return <Modal title={`Web terminal · ${session.name}`} subtitle={`root@${target.kind === 'ssh' ? target.host : target.name} · ${session.backend} · Closing detaches the terminal; your coding session keeps running.`}
    className={`web-terminal-dialog ${terminal && !manageKey ? 'has-terminal' : ''}`} onClose={() => void close()} closeDisabled={busy}>
    {error && <p className="error" role="alert">{error}</p>}
    {busy && <p className="terminal-loading" role="status"><LoaderCircle className="loading-spinner" size={18} /> {status?.key ? 'Connecting securely…' : 'Preparing web terminal…'}</p>}
    {terminal && !manageKey && <WebTerminal info={terminal} onRelaunch={launch} onManageKey={() => setManageKey(true)} />}
    {status && (!terminal || manageKey) && <div className="terminal-key-setup">
      <div className="terminal-key-intro"><KeyRound size={22} /><div><strong>{status.key ? 'Private key for this target' : 'Add your SSH private key'}</strong>
        <p>Your private key is encrypted and stored on Outpost to connect to this target. A passphrase unlocks the upload once and is discarded. You can remove the key at any time. Upload a key authorized for root on this server.</p></div></div>
      {status.key && <div className="terminal-saved-key"><code>{status.key.fingerprint}</code><small>Uploaded {new Date(status.key.uploadedAt).toLocaleDateString()}</small>
        {status.key.hostFingerprint && <small>Trusted host: <code>{status.key.hostFingerprint}</code></small>}
        <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => terminal ? setManageKey(false) : void launch()}>{terminal ? 'Return to terminal' : 'Launch web terminal'}</button>
          <button className="button danger" disabled={busy} onClick={() => void removeKey()}>Remove saved key</button></div></div>}
      {keyProblem && <button className="button danger" disabled={busy} onClick={() => void removeKey()}>Remove saved key</button>}
      {!status.encryptionAvailable ? <p role="alert" className="error">The administrator must configure OUTPOST_TERMINAL_ENCRYPTION_KEY before private keys can be uploaded.</p> : <form onSubmit={event => void saveKey(event)}>
        <label>Private key file<input type="file" aria-label="Private key file" disabled={busy} onChange={event => {
          const file = event.target.files?.[0]
          if (!file) return
          if (file.size > 64 * 1024) { setError('Private keys must fit within 64 KiB.'); event.target.value = ''; return }
          void file.text().then(value => { if (alive.current) { setPrivateKey(value); setError('') } })
        }} /></label>
        <label>Or paste a private key<textarea aria-label="Private key" value={privateKey} onChange={event => setPrivateKey(event.target.value)} spellCheck={false} autoComplete="off" autoCapitalize="off" disabled={busy} rows={5} maxLength={64 * 1024} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" /></label>
        <label>Passphrase (if encrypted)<input type="password" aria-label="Key passphrase" value={passphrase} onChange={event => setPassphrase(event.target.value)} autoComplete="off" disabled={busy} maxLength={1024} /></label>
        <p className="form-note">This key is used only when you choose “Launch with web terminal”. The regular Connect button keeps using your own terminal.</p>
        <div className="modal-actions"><button className="button primary" disabled={busy || !privateKey.trim()} type="submit">{status.key ? 'Replace key and launch' : 'Save key and launch'}</button></div>
      </form>}
    </div>}
    {!busy && !status && <button className="button secondary" onClick={onClose}>Close</button>}
  </Modal>
}
