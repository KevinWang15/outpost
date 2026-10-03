import { useState, type FormEvent } from 'react'
import { api } from './api'
import { useAuth } from './useAuth'
import { Modal } from './ui'
import AccountSshKey from './AccountSshKey'

export default function AccountSettings({ onClose }: { onClose: () => void }) {
  const { user, refresh, navigate } = useAuth()
  const [name, setName] = useState(user!.name)
  const [error, setError] = useState(''), [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  async function save(event: FormEvent<HTMLFormElement>, passwordChange = false) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('')
    const form = event.currentTarget
    try {
      if (passwordChange) {
        const data = new FormData(form)
        if (data.get('password') !== data.get('confirmation')) throw new Error('Passwords do not match.')
        await api('/account/password', 'POST', { currentPassword: data.get('currentPassword'), password: data.get('password') })
        form.reset(); await refresh(); navigate('/login')
      } else {
        await api('/account/profile', 'PATCH', { name: name.trim() })
        await refresh(); setMessage('Profile saved.')
      }
    } catch (problem) { setError((problem as Error).message) }
    finally { setBusy(false) }
  }
  return <Modal title="Your account" subtitle="Manage your profile, password, and access to development servers." onClose={onClose} closeDisabled={busy}>
    <form onSubmit={event => void save(event)}>
      <label>Name<input autoFocus required name="name" value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label>
      <label>Email<input value={user!.email} readOnly /><small>Your verified sign-in email.</small></label>
      <button className="button secondary" disabled={busy}>Save profile</button>
    </form>
    <AccountSshKey />
    <details className="account-password"><summary>Change password</summary><form onSubmit={event => void save(event, true)}>
      <label>Current password<input type="password" name="currentPassword" autoComplete="current-password" required maxLength={1024} /></label>
      <label>New password<input type="password" name="password" autoComplete="new-password" required minLength={8} maxLength={1024} /></label>
      <label>Confirm new password<input type="password" name="confirmation" autoComplete="new-password" required minLength={8} maxLength={1024} /></label>
      <p className="subtle">Changing your password signs you out on every device and expires connection commands.</p>
      <button className="button primary" disabled={busy}>Change password</button>
    </form></details>
    {message && <p role="status">{message}</p>}{error && <p className="error" role="alert">{error}</p>}
    <div className="modal-actions"><button className="button secondary" onClick={onClose} disabled={busy}>Done</button></div>
  </Modal>
}
