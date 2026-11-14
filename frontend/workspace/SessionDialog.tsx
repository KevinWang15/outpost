import { useId, useState, type FormEvent, type ReactNode } from 'react'
import type { ConversationMatch, Session, SessionInput, Target } from '../../shared/model'
import { harnessLabel, type HarnessId } from '../../shared/harnesses'
import { ToolIcon } from '../ui/ToolIcon'
import { Dialog } from '../ui/Dialog'
import DirectoryInput, { type DirectorySource } from './DirectoryInput'
import LaunchFields from './LaunchFields'
import { launchDraft, readDraft, settingsProblem } from './launch'

/** An existing session whose settings a new one can start from. */
export interface SettingsSource {
  key: string
  label: string
  session: Pick<Session, 'tool' | 'config'>
}

/** Create a session, or link an existing conversation found by Find conversations. */
export default function SessionDialog({
  target,
  tools,
  conversation,
  directories,
  beforeFields,
  description,
  copyFrom = [],
  onSave,
  onClose,
}: {
  target: Pick<Target, 'name'> | null
  tools: HarnessId[]
  conversation: ConversationMatch | null
  directories: DirectorySource
  beforeFields?: ReactNode
  description?: string
  /** Sessions to offer under Copy settings from. */
  copyFrom?: SettingsSource[]
  onSave: (input: SessionInput) => Promise<void>
  onClose: () => void
}) {
  const [selectedTool, setTool] = useState<HarnessId>()
  const tool = conversation?.tool ?? (selectedTool && tools.includes(selectedTool) ? selectedTool : tools[0])
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [launch, setLaunch] = useState(() => launchDraft())
  const [copied, setCopied] = useState('')
  const copyId = useId()
  const available = target && (conversation ? tools.includes(conversation.tool) : Boolean(tool))

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !available) return
    const data = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      if (!tool) throw new Error('Install a coding tool on this machine first.')
      const name = String(data.get('name')).trim()
      const settings = readDraft(launch)
      const problem = settingsProblem({ name, delivery: 'auto', ...settings })
      if (problem) throw new Error(problem)
      await onSave({
        tool,
        name,
        rootDir: String(data.get('rootDir')),
        ...(conversation
          ? { conversation: conversation.conversation, storage: conversation.storage }
          : { createDirectory: data.get('createDirectory') === 'on' }),
        ...settings,
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
            ? (description ?? `On ${target.name}. It starts when you first connect.`)
            : 'Choose where the session runs.'
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
              {copyFrom.length > 0 && (
                <div className="field">
                  <label className="label" htmlFor={copyId}>
                    Copy settings from
                  </label>
                  <select
                    id={copyId}
                    value={copied}
                    onChange={event => {
                      const source = copyFrom.find(item => item.key === event.target.value)
                      setCopied(event.target.value)
                      setLaunch(launchDraft(source?.session.config))
                      if (source && !conversation && tools.includes(source.session.tool)) setTool(source.session.tool)
                    }}
                  >
                    <option value="">Nothing; start empty</option>
                    {copyFrom.map(item => (
                      <option key={item.key} value={item.key}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                  <small>
                    Its instructions, model, mode, MCP servers, arguments and environment
                    {conversation ? '' : ', and its coding tool if this machine has it'}.
                  </small>
                </div>
              )}
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
                      <ToolIcon tool={value} size={15} />
                      {harnessLabel(value)}
                    </label>
                  ))}
                </div>
                {!available && (
                  <small className="error">
                    Install {conversation ? harnessLabel(conversation.tool) : 'a coding tool'} on this machine first.
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
              <LaunchFields key={copied} tool={tool} value={launch} onChange={setLaunch} />
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
