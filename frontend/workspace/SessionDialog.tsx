import { useState, type FormEvent, type ReactNode } from 'react'
import type { ConversationMatch, SessionInput, Target } from '../../shared/model'
import { harnessLabel, type HarnessId } from '../../shared/harnesses'
import { ToolIcon } from '../ui/ToolIcon'
import { Dialog } from '../ui/Dialog'
import DirectoryInput, { type DirectorySource } from './DirectoryInput'
import LaunchFields, { InstructionsField } from './LaunchFields'
import { readLaunch } from './launch'

/** Create a session, or link an existing conversation found by Find conversations. */
export default function SessionDialog({
  target,
  tools,
  conversation,
  directories,
  beforeFields,
  description,
  onSave,
  onClose,
}: {
  target: Pick<Target, 'name'> | null
  tools: HarnessId[]
  conversation: ConversationMatch | null
  directories: DirectorySource
  beforeFields?: ReactNode
  description?: string
  onSave: (input: SessionInput) => Promise<void>
  onClose: () => void
}) {
  const [selectedTool, setTool] = useState<HarnessId>()
  const tool = conversation?.tool ?? (selectedTool && tools.includes(selectedTool) ? selectedTool : tools[0])
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const available = target && (conversation ? tools.includes(conversation.tool) : Boolean(tool))

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !available) return
    const data = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      if (!tool) throw new Error('Install a coding tool on this machine first.')
      const { args, env } = readLaunch(data)
      const instructions = String(data.get('instructions')).trim()
      await onSave({
        tool,
        name: String(data.get('name')).trim(),
        rootDir: String(data.get('rootDir')),
        ...(conversation
          ? { conversation: conversation.conversation, storage: conversation.storage }
          : { createDirectory: data.get('createDirectory') === 'on' }),
        ...(args ? { args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(instructions ? { instructions } : {}),
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
              <InstructionsField tool={tool} />
              <LaunchFields tool={tool} />
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
