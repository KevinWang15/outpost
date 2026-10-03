import { useEffect, useState, type FormEvent } from 'react'
import { ArrowRight, Link } from 'lucide-react'
import type {
  LocalEnvironment,
  TargetInput,
  SessionBackend,
  CodingTool,
} from '../shared/session-manager'
import { api } from './api'
import { Modal } from './ui'
import ToolPicker from './ToolPicker'
import BackendPicker from './BackendPicker'

export default function TargetForm({
  onSave,
  onClose,
}: {
  onSave: (input: TargetInput) => Promise<void>
  onClose: () => void
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [kind, setKind] = useState<'ssh' | 'local'>('ssh')
  const [environment, setEnvironment] = useState<LocalEnvironment | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    api<LocalEnvironment>('/environment', 'GET', undefined, controller.signal)
      .then(setEnvironment)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message)
      })
    return () => controller.abort()
  }, [])
  const [tools, setTools] = useState<CodingTool[]>(['codex'])
  const [backends, setBackends] = useState<SessionBackend[]>(['tmux'])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const data = new FormData(event.currentTarget)
    try {
      await onSave(
        kind === 'local'
          ? {
              kind,
              name: String(data.get('name')),
              backends,
              tools,
              ...(data.get('distribution')
                ? { distribution: String(data.get('distribution')) }
                : {}),
            }
          : {
              kind,
              name: String(data.get('name')),
              host: String(data.get('host')),
              backends,
              tools,
              ...(data.get('port') ? { port: Number(data.get('port')) } : {}),
              ...(data.get('identityFile')
                ? { identityFile: String(data.get('identityFile')) }
                : {}),
            },
      )
    } catch (error) {
      setError((error as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal
      title="Add a target"
      subtitle="Run sessions on this computer or connect a dev machine over SSH."
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="form-row target-identity">
          <label>
            Connection type
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as 'ssh' | 'local')}
            >
              <option value="ssh">SSH — remote dev machine</option>
              <option value="local" disabled={!environment?.supported}>
                Local — this computer
              </option>
            </select>
          </label>
          <label>
            Target name
            <input
              name="name"
              required
              maxLength={80}
              placeholder="My dev machine"
              autoFocus
            />
          </label>
        </div>
        {kind === 'ssh' ? (
          <>
            <label>
              Host or SSH alias
              <input
                name="host"
                required
                placeholder="dev.example.com"
                spellCheck={false}
              />
            </label>
            <div className="form-row">
              <label>
                SSH user
                <input value="root" readOnly />
              </label>
              <label>
                Port <span>optional</span>
                <input
                  name="port"
                  type="number"
                  min="1"
                  max="65535"
                  placeholder="From SSH config / 22"
                />
              </label>
            </div>
            <label>
              Identity file <span>optional</span>
              <input
                name="identityFile"
                placeholder="~/.ssh/id_ed25519"
                spellCheck={false}
              />
              <small>
                Local key path. Windows paths are supported; ~/ uses each
                computer’s home directory.
              </small>
            </label>
          </>
        ) : (
          <>
            <p className="terminal-help">
              Sessions run as your user on the computer running the manager.{' '}
              {environment?.usesWsl
                ? 'Windows uses WSL. Coding tools and project directories must be inside that distribution.'
                : 'No SSH connection is needed.'}
            </p>
            {environment?.usesWsl && (
              <label>
                WSL distribution <span>optional</span>
                <input
                  name="distribution"
                  placeholder="Default distribution"
                  maxLength={128}
                />
                <small>
                  The selected distribution is saved with this target.
                </small>
              </label>
            )}
          </>
        )}
        <BackendPicker value={backends} onChange={setBackends} />
        <ToolPicker value={tools} onChange={setTools} />
        <div className="form-note">
          <Link />
          <p>
            {kind === 'ssh'
              ? 'Uses your SSH config and agent.'
              : 'Uses your local account.'}{' '}
            Adding an instance saves its settings and checks required software.
            Install missing software from its detail page after reviewing the
            installation script.
          </p>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !tools.length || !backends.length}>
            {busy ? 'Adding target…' : 'Add target'}
            <ArrowRight />
          </button>
        </div>
      </form>
    </Modal>
  )
}
