import { useState, type FormEvent } from 'react'
import type { Session, SessionForkInput, Target } from '../../shared/model'
import { harnessLabel } from '../../shared/harnesses'
import { Dialog } from '../ui/Dialog'

function suggestedPath(root: string, branch: string) {
  const suffix = branch
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return suffix ? `${root.replace(/\/+$/, '') || '/'}-${suffix}` : ''
}

export default function ForkDialog({
  session,
  target,
  onSave,
  onClose,
}: {
  session: Session
  target: Target
  onSave: (input: SessionForkInput) => Promise<void>
  onClose: () => void
}) {
  const [branch, setBranch] = useState('')
  const [override, setOverride] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const path = override ?? suggestedPath(session.rootDir, branch)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await onSave({ branch: branch.trim(), rootDir: path })
    } catch (problem) {
      setError((problem as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={`Fork ${session.name}`}
      description={`Create a fresh ${harnessLabel(session.tool)} session on ${target.name}, with the same arguments and environment.`}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button className="button" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" form="fork-form" disabled={busy || !branch.trim() || !path}>
            {busy ? 'Forking…' : 'Fork session'}
          </button>
        </>
      }
    >
      <form id="fork-form" className="form" onSubmit={submit}>
        <label className="field">
          <span className="label">New Git branch</span>
          <input
            required
            autoFocus
            maxLength={256}
            spellCheck={false}
            placeholder="feature/new-login"
            value={branch}
            disabled={busy}
            onChange={event => setBranch(event.target.value)}
          />
          <small>Starts from the source directory’s current commit. Uncommitted changes stay in the source.</small>
        </label>
        <label className="field">
          <span className="label">Worktree directory</span>
          <input
            required
            maxLength={4096}
            pattern="(?:/|~/).*"
            title="Use an absolute path or a path starting with ~/"
            spellCheck={false}
            value={path}
            disabled={busy}
            onChange={event => setOverride(event.target.value)}
          />
          <small>The new directory must not already exist.</small>
        </label>
        {override !== null && (
          <button className="button small" type="button" disabled={busy} onClick={() => setOverride(null)}>
            Use suggested path
          </button>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}
