import { useRef, useState, type FormEvent } from 'react'
import { ChevronDown, Plus, Terminal, Trash2 } from 'lucide-react'
import type {
  CodingTool,
  Target,
  SessionInput,
  SessionBackend,
  CodingSessionMatch,
} from '../shared/session-manager'
import { codingToolLabels } from '../shared/session-manager'
import TargetDirectoryInput from './TargetDirectoryInput'
import { Modal } from './ui'

export default function SessionForm({
  target,
  tools,
  backends,
  conversation,
  onSave,
  onClose,
}: {
  target: Target
  tools: CodingTool[]
  backends: SessionBackend[]
  conversation?: CodingSessionMatch | null
  onSave: (input: SessionInput) => Promise<void>
  onClose: () => void
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const [selectedTool, setTool] = useState<CodingTool>(conversation?.tool ?? tools[0])
  const [selectedBackend, setBackend] = useState<SessionBackend>(backends[0])
  const tool = conversation ? tools.includes(conversation.tool) ? conversation.tool : undefined
    : tools.includes(selectedTool) ? selectedTool : tools[0]
  const backend = backends.includes(selectedBackend) ? selectedBackend : backends[0]
  const [envRows, setEnvRows] = useState<number[]>([])
  const nextEnvId = useRef(0)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const data = new FormData(event.currentTarget)
    try {
      if (!tool || !backend) throw new Error('Check Required Software before creating a session.')
      const names = data.getAll('envName').map(String)
      if (new Set(names).size !== names.length)
        throw new Error('Environment variable names must be unique.')
      const values = data.getAll('envValue').map(String)
      const args = String(data.get('args') ?? '')
      await onSave({
        tool,
        backend,
        name: String(data.get('name')),
        rootDir: String(data.get('rootDir')),
        createDirectory: data.get('createDirectory') === 'on',
        ...(conversation ? { cliSessionId: conversation.cliSessionId, cliSessionEnv: conversation.cliSessionEnv } : {}),
        ...(args ? { args } : {}),
        ...(names.length
          ? {
              env: Object.fromEntries(
                names.map((name, index) => [name, values[index]]),
              ),
            }
          : {}),
      })
    } catch (error) {
      setError((error as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal
      title={conversation ? 'Link a coding session' : 'Create a session'}
      subtitle={conversation ? `Resume this ${codingToolLabels[conversation.tool]} conversation on ${target.name}.` : `Give your work a home on ${target.name}.`}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <label>
          Session name
          <input
            name="name"
            placeholder="Build the next thing"
            defaultValue={conversation?.title.slice(0, 80)}
            required
            maxLength={80}
            autoFocus
          />
        </label>
        <div className="form-row">
          <label>
            Session backend
            <select
              name="backend"
              value={backend ?? ''}
              required
              disabled={busy || !backends.length}
              onChange={(event) => setBackend(event.target.value as SessionBackend)}
            >
              {backends.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Coding tool
            <select
              name="tool"
              value={tool ?? ''}
              required
              disabled={busy || !tools.length || Boolean(conversation)}
              onChange={(event) => setTool(event.target.value as CodingTool)}
            >
              {tools.map((value) => (
                <option key={value} value={value}>
                  {codingToolLabels[value]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {conversation ? <>
          <label>Root directory<input name="rootDir" value={conversation.rootDir} readOnly /></label>
          <p className="coding-session-id">Coding CLI session ID <code>{conversation.cliSessionId}</code></p>
        </> : <TargetDirectoryInput targetId={target.id} />}
        {!conversation && <label className="checkbox-label">
          <input type="checkbox" name="createDirectory" /> Create the directory
          if it doesn’t exist
        </label>}
        <details className="session-options">
          <summary><ChevronDown size={14} aria-hidden="true" /> Arguments and environment variables (optional)</summary>
          <label>
            Arguments
            <textarea
              name="args"
              aria-label="Arguments"
              aria-describedby="session-args-hint"
              rows={2}
              maxLength={8192}
              placeholder={'--flag "value with spaces"'}
              spellCheck={false}
            />
            <small id="session-args-hint">
              Appended to {tool}. Bash quoting and variable expansion are
              supported.
            </small>
          </label>
          <fieldset className="session-environment">
            <legend>Environment variables</legend>
            {envRows.map((id, index) => (
              <div className="session-env-row" key={id}>
                <label>
                  Name
                  <input
                    name="envName"
                    aria-label={`Environment variable name ${index + 1}`}
                    placeholder="VARIABLE_NAME"
                    required
                    pattern="[A-Za-z_][A-Za-z0-9_]*"
                    maxLength={128}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label>
                  Value
                  <textarea
                    name="envValue"
                    aria-label={`Environment variable value ${index + 1}`}
                    rows={1}
                    maxLength={4096}
                    placeholder="Value"
                    spellCheck={false}
                  />
                </label>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove environment variable ${index + 1}`}
                  disabled={busy}
                  onClick={() =>
                    setEnvRows((rows) => rows.filter((row) => row !== id))
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button secondary"
              disabled={busy || envRows.length >= 32}
              onClick={() => {
                const id = nextEnvId.current++
                setEnvRows((rows) => [...rows, id])
              }}
            >
              <Plus size={14} /> Add variable
            </button>
            <small>
              Values are passed literally and saved with this session on the
              instance.
            </small>
          </fieldset>
        </details>
        <div className="form-note">
          <Terminal />
          <p>
            Uses <strong>{backend}</strong>. {tool && codingToolLabels[tool]}{' '}
            starts when you connect, and resumes the same conversation after a restart.
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
          <button className="button primary" disabled={busy || !tool || !backend}>
            {busy ? conversation ? 'Linking…' : 'Creating…' : conversation ? 'Link session' : 'Create session'}
            <Plus />
          </button>
        </div>
      </form>
    </Modal>
  )
}
