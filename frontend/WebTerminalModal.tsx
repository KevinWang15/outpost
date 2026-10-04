import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyRound, LoaderCircle } from 'lucide-react'
import type { Session, Target } from '../shared/session-manager'
import type { TerminalKeySource, TerminalKeyStatus, WebTerminalInfo } from '../shared/web-terminal'
import { api, ApiError } from './api'
import { Modal } from './ui'
import WebTerminal from './WebTerminal'
import { useAuth } from './useAuth'

export default function WebTerminalModal({ target, session, differentKey = false, onClose }: { target: Target; session: Session; differentKey?: boolean; onClose: () => void }) {
  const hosted = useAuth().mode === 'hosted'
  const base = `/targets/${target.id}`
  const [status, setStatus] = useState<TerminalKeyStatus | null>(null)
  const [terminal, setTerminal] = useState<(WebTerminalInfo & { keySource: TerminalKeySource }) | null>(null)
  const [manageKey, setManageKey] = useState(false)
  const initialSource: TerminalKeySource = hosted && !differentKey ? 'account' : 'uploaded'
  const [source, setSource] = useState<TerminalKeySource>(initialSource)
  const [keyProblem, setKeyProblem] = useState(false)
  const [privateKey, setPrivateKey] = useState(''), [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(true), [error, setError] = useState('')
  const alive = useRef(true), terminalId = useRef<string | null>(null), terminalSource = useRef<TerminalKeySource | null>(null)
  const launch = useCallback(async (keySource: TerminalKeySource) => {
    setBusy(true); setError('')
    try {
      if (terminalId.current && terminalSource.current !== keySource) {
        await api(`/web-terminals/${terminalId.current}`, 'DELETE').catch(error => { if (error.status !== 404) throw error })
        terminalId.current = null; setTerminal(null)
      }
      setSource(keySource)
      const info = await api<WebTerminalInfo>(`${base}/sessions/${session.id}/web-terminal`, 'POST', { cols: 80, rows: 24, keySource })
      if (!alive.current) { void api(`/web-terminals/${info.id}`, 'DELETE').catch(() => {}); return }
      terminalId.current = info.id; terminalSource.current = keySource; setTerminal({ ...info, keySource }); setManageKey(false)
    } catch (error) { if (alive.current) setError((error as Error).message) }
    finally { if (alive.current) setBusy(false) }
  }, [base, session.id])
  useEffect(() => {
    alive.current = true
    void api<TerminalKeyStatus>(`${base}/terminal-key`).then(info => {
      if (!alive.current) return
      setStatus(info)
      setKeyProblem(Boolean(info.keyError))
      if (initialSource === 'uploaded' && info.keyError) setError(info.keyError)
      if (!differentKey && (initialSource === 'account' ? info.accountKey : info.key)) void launch(initialSource)
      else { setManageKey(true); setBusy(false) }
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
  }, [base, launch, initialSource, differentKey])
  async function saveKey(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const info = await api<TerminalKeyStatus>(`${base}/terminal-key`, 'PUT', { privateKey, passphrase })
      if (!alive.current) return
      setStatus(info); setKeyProblem(false); setPrivateKey(''); setPassphrase(''); terminalId.current = null; setTerminal(null)
      await launch('uploaded')
    } catch (error) { if (alive.current) { setError((error as Error).message); setBusy(false) } }
  }
  async function removeKey() {
    setBusy(true); setError('')
    try {
      await api(`${base}/terminal-key`, 'DELETE')
      terminalId.current = null; setTerminal(null); setManageKey(true)
      const info = await api<TerminalKeyStatus>(`${base}/terminal-key`)
      if (!alive.current) return
      setStatus(info); setSource(info.accountKey ? 'account' : 'uploaded'); setKeyProblem(false); setPrivateKey(''); setPassphrase('')
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
    {busy && <p className="terminal-loading" role="status"><LoaderCircle className="loading-spinner" size={18} /> {status?.key || status?.accountKey ? 'Connecting securely…' : 'Preparing web terminal…'}</p>}
    {terminal && !manageKey && <WebTerminal info={terminal} onRelaunch={() => launch(source)} onManageKey={() => setManageKey(true)} />}
    {status && (!terminal || manageKey) && <div className="terminal-key-setup">
      <div className="terminal-key-intro"><KeyRound size={22} /><div><strong>{source === 'account' ? 'Your Outpost account key' : status.key ? 'Private key for this target' : 'Add your SSH private key'}</strong>
        <p>{source === 'account' ? 'Web terminals use the same Outpost key as session management. This key belongs only to your account. Authorize its public key in /root/.ssh/authorized_keys on your server.' : 'Upload a private key authorized for root on this server. It is used only when you select this connection option.'}</p></div></div>
      {source === 'account' && status.accountKey && <div className="terminal-saved-key">
        <code>{status.accountKey.fingerprint}</code>
        <pre>{status.accountKey.publicKey}</pre>
        <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => terminal ? setManageKey(false) : void launch('account')}>{terminal ? 'Return to terminal' : 'Launch web terminal'}</button>
          <button className="button secondary" disabled={busy} onClick={() => { setSource('uploaded'); if (status.keyError) setError(status.keyError) }}>Use a different key</button></div>
      </div>}
      {source === 'uploaded' && status.accountKey && <button className="button secondary" disabled={busy} onClick={() => void launch('account')}>Use Outpost account key</button>}
      {source === 'uploaded' && status.key && <div className="terminal-saved-key"><code>{status.key.fingerprint}</code><small>Uploaded {new Date(status.key.uploadedAt).toLocaleDateString()}</small>
        {status.key.hostFingerprint && <small>Trusted host: <code>{status.key.hostFingerprint}</code></small>}
        <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => terminal?.keySource === 'uploaded' ? setManageKey(false) : void launch('uploaded')}>{terminal?.keySource === 'uploaded' ? 'Return to terminal' : 'Launch web terminal'}</button>
          <button className="button danger" disabled={busy} onClick={() => void removeKey()}>Remove saved key</button></div></div>}
      {source === 'uploaded' && keyProblem && <button className="button danger" disabled={busy} onClick={() => void removeKey()}>Remove saved key</button>}
      {source === 'uploaded' && (!status.encryptionAvailable ? <p role="alert" className="error">Private-key uploads are unavailable because the server’s encryption configuration is invalid. Contact the administrator.</p> : <form onSubmit={event => void saveKey(event)}>
        <p className="form-note">Uploaded keys are encrypted on Outpost. A passphrase unlocks the upload once and is discarded.</p>
        <label>Private key file<input type="file" aria-label="Private key file" disabled={busy} onChange={event => {
          const file = event.target.files?.[0]
          if (!file) return
          if (file.size > 64 * 1024) { setError('Private keys must fit within 64 KiB.'); event.target.value = ''; return }
          void file.text().then(value => { if (alive.current) { setPrivateKey(value); setError('') } })
        }} /></label>
        <label>Or paste a private key<textarea aria-label="Private key" value={privateKey} onChange={event => setPrivateKey(event.target.value)} spellCheck={false} autoComplete="off" autoCapitalize="off" disabled={busy} rows={5} maxLength={64 * 1024} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" /></label>
        <label>Passphrase (if encrypted)<input type="password" aria-label="Key passphrase" value={passphrase} onChange={event => setPassphrase(event.target.value)} autoComplete="off" disabled={busy} maxLength={1024} /></label>
        <p className="form-note">{hosted ? 'The main Connect using web terminal button uses your Outpost account key. Connection options prepares a command for your own terminal.' : 'This key is used only when you choose “Launch with web terminal”. The regular Connect button opens your desktop terminal.'}</p>
        <div className="modal-actions"><button className="button primary" disabled={busy || !privateKey.trim()} type="submit">{status.key ? 'Replace key and launch' : 'Save key and launch'}</button></div>
      </form>)}
    </div>}
    {!busy && !status && <button className="button secondary" onClick={onClose}>Close</button>}
  </Modal>
}
