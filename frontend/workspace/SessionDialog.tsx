import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ChevronRight, Plus, Trash2 } from 'lucide-react'
import type { ConversationMatch, SessionInput, Target } from '../../shared/model'
import { harnessLabel, type HarnessId } from '../../shared/harnesses'
import { Dialog } from '../ui/Dialog'
import DirectoryInput, { type DirectorySource } from './DirectoryInput'

/** Create a session, or link an existing conversation found by Find conversations. */
export default function SessionDialog({
  target,
  tools,
  conversation,
  directories,
  beforeFields,
  onSave,
  onClose,
}: {
  target: Pick<Target, 'name'> | null
  tools: HarnessId[]
  conversation: ConversationMatch | null
  directories: DirectorySource
  beforeFields?: ReactNode
  onSave: (input: SessionInput) => Promise<void>
  onClose: () => void
}) {
  const [selectedTool, setTool] = useState<HarnessId>()
  const tool = conversation?.tool ?? (selectedTool && tools.includes(selectedTool) ? selectedTool : tools[0])
  const [variables, setVariables] = useState<number[]>([])
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const nextVariable = useRef(0)
  const available = target && (conversation ? tools.includes(conversation.tool) : Boolean(tool))

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !available) return
    const data = new FormData(event.currentTarget)
    const names = data.getAll('envName').map(String),
      values = data.getAll('envValue').map(String)
    const args = String(data.get('args') ?? '')
    setBusy(true)
    setError('')
    try {
      if (!tool) throw new Error('Install a coding tool on this target first.')
      if (new Set(names).size !== names.length) throw new Error('Environment variable names must be unique.')
      await onSave({
        tool,
        name: String(data.get('name')).trim(),
        rootDir: String(data.get('rootDir')),
        ...(conversation
          ? { cliSessionId: conversation.cliSessionId, cliSessionEnv: conversation.cliSessionEnv }
          : { createDirectory: data.get('createDirectory') === 'on' }),
        ...(args ? { args } : {}),
        ...(names.length ? { env: Object.fromEntries(names.map((name, index) => [name, values[index]])) } : {}),
      })
    } catch (problem) {
      setError((problem as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={conversation ? 'Link a conversation' : 'New session'}
      busy={busy}
      onClose={onClose}
      description={
        conversation
          ? `Resume this ${harnessLabel(conversation.tool)} conversation as an Outpost session.`
          : target
            ? `On ${target.name}. It starts when you first connect.`
            : 'Choose an Outpost server and execution target.'
      }
      footer={
        <>
          <button className="button" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" form="session-form" disabled={busy || !available}>
            {busy ? 'Creating…' : conversation ? 'Link session' : 'Create session'}
          </button>
        </>
      }
    >
      <form id="session-form" className="form" onSubmit={submit}>
        <fieldset className="session-fields" disabled={busy}>
          {beforeFields}
          {target && (
            <>
              <label className="field">
                <span className="label">Name</span>
                <input
                  name="name"
                  required
                  maxLength={80}
                  autoFocus
                  defaultValue={conversation?.title.slice(0, 80)}
                  placeholder="Refactor billing"
                />
              </label>
              <fieldset className="field">
                <legend className="label">Coding tool</legend>
                <div className="toggle-group">
                  {(conversation ? [conversation.tool] : tools).map(value => (
                    <label key={value} className="toggle">
                      <input
                        type="radio"
                        name="tool"
                        value={value}
                        checked={tool === value}
                        disabled={Boolean(conversation)}
                        onChange={() => setTool(value)}
                      />
                      {harnessLabel(value)}
                    </label>
                  ))}
                </div>
                {!available && (
                  <small className="error">
                    Install {conversation ? harnessLabel(conversation.tool) : 'a coding tool'} on this target first.
                  </small>
                )}
              </fieldset>
              {conversation ? (
                <label className="field">
                  <span className="label">Project directory</span>
                  <input name="rootDir" value={conversation.rootDir} readOnly />
                </label>
              ) : (
                <>
                  <DirectoryInput source={directories} />
                  <label className="check">
                    <input type="checkbox" name="createDirectory" />
                    Create the directory if it doesn’t exist
                  </label>
                </>
              )}
              <details className="disclosure">
                <summary>
                  <ChevronRight size={14} />
                  Arguments and environment
                </summary>
                <label className="field">
                  <span className="label">Arguments</span>
                  <textarea name="args" rows={2} maxLength={8192} spellCheck={false} placeholder='--model "$MODEL"' />
                  <small>
                    Appended to the {tool ? harnessLabel(tool) : 'tool'} command. Bash quoting and expansion apply.
                  </small>
                </label>
                <div className="field">
                  <span className="label">Environment variables</span>
                  {variables.map((id, index) => (
                    <div className="env-row" key={id}>
                      <input
                        name="envName"
                        aria-label={`Variable ${index + 1} name`}
                        required
                        pattern="[A-Za-z_][A-Za-z0-9_]*"
                        maxLength={128}
                        placeholder="NAME"
                        spellCheck={false}
                      />
                      <input
                        name="envValue"
                        aria-label={`Variable ${index + 1} value`}
                        maxLength={4096}
                        placeholder="value"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove variable ${index + 1}`}
                        onClick={() => setVariables(rows => rows.filter(row => row !== id))}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="button small"
                    disabled={variables.length >= 32}
                    onClick={() => setVariables(rows => [...rows, nextVariable.current++])}
                  >
                    <Plus size={14} />
                    Add variable
                  </button>
                </div>
              </details>
            </>
          )}
        </fieldset>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}
