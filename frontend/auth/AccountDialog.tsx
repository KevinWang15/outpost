import { useState, type FormEvent } from 'react'
import { pagePaths } from '../../shared/pages'
import { api } from '../api'
import { Dialog } from '../ui/Dialog'
import AccountKey from './AccountKey'
import { useAuth } from './useAuth'

export default function AccountDialog({ onClose }: { onClose: () => void }) {
  const { user, refresh, navigate } = useAuth()
  const [name, setName] = useState(user!.name)
  const [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  async function save(event: FormEvent<HTMLFormElement>, password = false) {
    event.preventDefault()
    const form = event.currentTarget
    setBusy(true)
    setError('')
    setMessage('')
    try {
      if (password) {
        const data = new FormData(form)
        if (data.get('password') !== data.get('confirmation')) throw new Error('Passwords do not match.')
        await api('/account/password', 'POST', {
          currentPassword: data.get('currentPassword'),
          password: data.get('password'),
        })
        form.reset()
        await refresh()
        navigate(pagePaths.login)
      } else {
        await api('/account/profile', 'PATCH', { name: name.trim() })
        await refresh()
        setMessage('Profile saved.')
      }
    } catch (problem) {
      setError((problem as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="Your account"
      description={user!.email}
      busy={busy}
      onClose={onClose}
      footer={
        <button className="button" disabled={busy} onClick={onClose}>
          Done
        </button>
      }
    >
      <form className="form inline-form" onSubmit={event => void save(event)}>
        <label className="field grow">
          <span className="label">Name</span>
          <input required value={name} maxLength={80} onChange={event => setName(event.target.value)} />
        </label>
        <button className="button" disabled={busy}>
          Save
        </button>
      </form>
      <AccountKey />
      <details className="disclosure">
        <summary>Change password</summary>
        <form className="form" onSubmit={event => void save(event, true)}>
          <label className="field">
            <span className="label">Current password</span>
            <input type="password" name="currentPassword" autoComplete="current-password" required maxLength={1024} />
          </label>
          <label className="field">
            <span className="label">New password</span>
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={1024}
            />
          </label>
          <label className="field">
            <span className="label">Confirm new password</span>
            <input
              type="password"
              name="confirmation"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={1024}
            />
          </label>
          <p className="hint">Changing your password signs you out everywhere and closes open terminals.</p>
          <button className="button primary" disabled={busy}>
            Change password
          </button>
        </form>
      </details>
      {message && (
        <p className="success" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}
