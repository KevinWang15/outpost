import { useState, type FormEvent } from 'react'
import type { Session, SessionUpdate } from '../../shared/model'
import { harnessLabel } from '../../shared/harnesses'
import { Dialog } from '../ui/Dialog'
import LaunchFields from './LaunchFields'
import { readLaunch } from './launch'

const sameEnv = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value)

/** Edit a session: its name now, its launch configuration at the next start. */
export default function SessionSettingsDialog({
  session,
  onSave,
  onRestart,
  onClose,
}: {
  session: Session
  onSave: (update: SessionUpdate) => Promise<unknown>
  /** Stop the running session and start it again in the same conversation. */
  onRestart: () => Promise<void>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const running = session.driver !== null

  async function submit(event: FormEvent<HTMLFormElement>, restart: boolean) {
    event.preventDefault()
    if (busy) return
    const data = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      const { args, env } = readLaunch(data)
      const name = String(data.get('name')).trim()
      const instructions = String(data.get('instructions')).trim() || null
      const { config } = session
      const update: SessionUpdate = {
        revision: config.revision,
        ...(name !== session.name ? { name } : {}),
        ...(args !== config.args ? { args } : {}),
        ...(!sameEnv(env, config.env) ? { env } : {}),
        ...(instructions !== config.instructions ? { instructions } : {}),
      }
      if (Object.keys(update).length > 1) await onSave(update)
      if (restart) await onRestart()
      onClose()
    } catch (problem) {
      setError((problem as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={`Edit ${session.name}`}
      description={`${harnessLabel(session.tool)} in ${session.rootDir}. The coding tool and directory stay as they are; fork the session to work in another directory.`}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button className="button" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          {running && (
            <button className="button" form="session-settings" name="restart" value="1" disabled={busy}>
              Save and restart
            </button>
          )}
          <button className="button primary" form="session-settings" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form
        id="session-settings"
        className="form"
        onSubmit={event => {
          const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null
          void submit(event, submitter?.name === 'restart')
        }}
      >
        <fieldset className="session-fields" disabled={busy}>
          <label className="field">
            <span className="label">Name</span>
            <input name="name" required maxLength={80} autoFocus defaultValue={session.name} />
            <small>Yours to choose; it also sets the session’s @handle in chat.</small>
          </label>
          <label className="field">
            <span className="label">Chat instructions</span>
            <textarea
              name="instructions"
              rows={3}
              maxLength={32000}
              defaultValue={session.config.instructions ?? ''}
              placeholder="Optional. A role or rules for this session, e.g. “You review pull requests. Be concise.”"
            />
            <small>
              {session.tool === 'kimi'
                ? 'Kimi Code does not accept session instructions over ACP yet.'
                : 'Added to the coding tool’s own instructions in chat. Claude Code and Codex support this.'}
            </small>
          </label>
          <LaunchFields tool={session.tool} args={session.config.args} env={session.config.env} />
        </fieldset>
        {running && (
          <p className="hint">
            The running session keeps its current instructions, arguments and environment until it restarts. The
            conversation continues either way.
          </p>
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
