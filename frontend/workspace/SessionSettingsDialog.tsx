import { useId, useState, type FormEvent } from 'react'
import { Braces, ListChecks, RotateCcw, X } from 'lucide-react'
import type { Session, SessionSettings, SessionUpdate } from '../../shared/model'
import { harnessIds, harnessLabel, previewStartCommand, supportsTerminal, type HarnessId } from '../../shared/harnesses'
import { Dialog } from '../ui/Dialog'
import { ToolIcon } from '../ui/ToolIcon'
import DirectoryInput, { type DirectorySource } from './DirectoryInput'
import LaunchFields from './LaunchFields'
import { launchDraft, parseSource, readDraft, settingsProblem } from './launch'

const settingsOf = ({
  name,
  tool,
  rootDir,
  conversation,
  delivery,
  config: { revision: _, ...launch },
}: Session): SessionSettings => ({
  name,
  tool,
  rootDir,
  conversation,
  delivery,
  ...launch,
})

const restartKeys = new Set<keyof SessionSettings>([
  'tool',
  'rootDir',
  'conversation',
  'instructions',
  'model',
  'mode',
  'mcpServers',
  'args',
  'env',
])

const latestRemembered = (session: Session, tool: HarnessId) => {
  for (let i = session.conversations.length - 1; i >= 0; i--) {
    const item = session.conversations[i]!
    if (item.tool === tool && !item.movedTo) return item.id
  }
  return ''
}

/** Edit any parameter of a session (harness, name, directory, conversation/resume ID,
 * and launch settings). When a running session's startup parameters change, prompts
 * the user to close and restart it immediately. */
export default function SessionSettingsDialog({
  session,
  tools,
  directories,
  onSave,
  onRestart,
  onClose,
}: {
  session: Session
  /** Installed coding tools on the machine (all harnesses shown when omitted). */
  tools?: HarnessId[]
  /** Live directory suggestions on the machine, if available. */
  directories?: DirectorySource
  onSave: (update: SessionUpdate) => Promise<Session>
  /** Close and restart the running session with its updated settings. */
  onRestart: (updated: Session) => Promise<void>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState(session.name)
  const [tool, setTool] = useState<HarnessId>(session.tool)
  const [rootDir, setRootDir] = useState(session.rootDir)
  const [conversation, setConversation] = useState(session.conversation ?? '')
  const [delivery, setDelivery] = useState(session.delivery)
  const [launch, setLaunch] = useState(() => launchDraft(session.config))
  const [source, setSource] = useState<string | null>(null)
  const [restartPrompt, setRestartPrompt] = useState<Session | null>(null)
  // Remounts the form's fields with what the source said.
  const [generation, setGeneration] = useState(0)
  const datalistId = useId()
  const running = session.driver !== null
  const selectableTools = tools?.length
    ? ([...new Set<HarnessId>([session.tool, ...tools])] as HarnessId[])
    : [...harnessIds]
  const rememberedForTool = [...session.conversations].reverse().filter(item => item.tool === tool)

  const fromForm = (): SessionSettings => ({
    name: name.trim(),
    tool,
    rootDir: rootDir.trim(),
    conversation: conversation.trim() || null,
    delivery,
    ...readDraft(launch),
  })

  const preview = previewStartCommand(
    tool,
    {
      instructions: launch.instructions.trim() || null,
      model: launch.model.trim() || null,
      args: launch.args,
    },
    conversation.trim() || null,
  )

  function selectTool(next: HarnessId) {
    if (next === tool) return
    setTool(next)
    setConversation(next === session.tool ? (session.conversation ?? '') : latestRemembered(session, next))
  }

  function toggleSource() {
    setError('')
    try {
      if (source === null) return setSource(JSON.stringify(fromForm(), null, 2))
      const settings = parseSource(source)
      setName(settings.name)
      setTool(settings.tool)
      setRootDir(settings.rootDir)
      setConversation(settings.conversation ?? '')
      setDelivery(settings.delivery)
      setLaunch(launchDraft(settings))
      setGeneration(value => value + 1)
      setSource(null)
    } catch (problem) {
      setError((problem as Error).message)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setError('')
    try {
      const settings = source === null ? fromForm() : parseSource(source)
      const problem = settingsProblem(settings)
      if (problem) throw new Error(problem)
      const before = settingsOf(session)
      const update: SessionUpdate = { revision: session.config.revision }
      let needsRestart = false
      for (const key of Object.keys(settings) as (keyof SessionSettings)[])
        if (JSON.stringify(settings[key]) !== JSON.stringify(before[key])) {
          Object.assign(update, { [key]: settings[key] })
          if (restartKeys.has(key)) needsRestart = true
        }
      if (Object.keys(update).length <= 1) {
        onClose()
        return
      }
      setBusy(true)
      const saved = await onSave(update)
      if (running && needsRestart) {
        setRestartPrompt(saved)
        setBusy(false)
        return
      }
      onClose()
    } catch (problem) {
      setError((problem as Error).message)
      setBusy(false)
    }
  }

  async function confirmRestart() {
    if (!restartPrompt || busy) return
    setBusy(true)
    setError('')
    try {
      await onRestart(restartPrompt)
      onClose()
    } catch (problem) {
      setError((problem as Error).message)
      setBusy(false)
    }
  }

  if (restartPrompt) {
    const working = ['working', 'waiting'].includes(session.activity.state)
    const nextPreview = previewStartCommand(restartPrompt.tool, restartPrompt.config, restartPrompt.conversation)
    return (
      <Dialog
        title={`Restart ${restartPrompt.name}?`}
        description="Your changes have been saved. This session is still running with its previous settings — close and restart it now so the changes take effect?"
        busy={busy}
        onClose={onClose}
        footer={
          <>
            <button className="button" type="button" disabled={busy} onClick={onClose}>
              Later
            </button>
            <button className="button primary" type="button" disabled={busy} onClick={() => void confirmRestart()}>
              <RotateCcw size={14} />
              {busy ? 'Restarting…' : 'Close and restart now'}
            </button>
          </>
        }
      >
        <div className="form">
          {working && (
            <p className="warning" role="status">
              This session is working right now; restarting will interrupt the current turn.
            </p>
          )}
          <div className="start-command-preview">
            <span className="label">Next start command</span>
            <code>{nextPreview.command}</code>
            <small>
              {harnessLabel(restartPrompt.tool)} in <code>{restartPrompt.rootDir}</code>
            </small>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog
      title={`Edit ${session.name}`}
      description="Change the coding harness, directory, resume conversation ID, or any launch parameter."
      size={source === null ? 'medium' : 'large'}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button className="button push-left" type="button" disabled={busy} onClick={toggleSource}>
            {source === null ? <Braces size={14} /> : <ListChecks size={14} />}
            {source === null ? 'Edit source' : 'Edit as form'}
          </button>
          <button className="button" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" form="session-settings" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form id="session-settings" className="form" onSubmit={event => void submit(event)}>
        {source === null ? (
          <fieldset className="session-fields" disabled={busy} key={generation}>
            <label className="field">
              <span className="label">Name</span>
              <input
                name="name"
                required
                maxLength={80}
                autoFocus
                value={name}
                onChange={event => setName(event.target.value)}
              />
              <small>Yours to choose; it also sets the session’s @handle in chat.</small>
            </label>
            <fieldset className="field">
              <legend className="label">Coding harness</legend>
              <div className="toggle-group">
                {selectableTools.map(value => (
                  <label key={value} className="toggle">
                    <input
                      type="radio"
                      name="tool"
                      value={value}
                      checked={tool === value}
                      onChange={() => selectTool(value)}
                    />
                    <ToolIcon tool={value} size={15} />
                    {harnessLabel(value)}
                  </label>
                ))}
              </div>
              {tool !== session.tool && (
                <small>
                  Switching from {harnessLabel(session.tool)} to {harnessLabel(tool)} preserves earlier{' '}
                  {harnessLabel(session.tool)} conversation IDs on this session.
                </small>
              )}
            </fieldset>
            {directories ? (
              <DirectoryInput source={directories} value={rootDir} onChange={setRootDir} />
            ) : (
              <label className="field">
                <span className="label">Project directory</span>
                <input
                  name="rootDir"
                  required
                  maxLength={4096}
                  spellCheck={false}
                  value={rootDir}
                  onChange={event => setRootDir(event.target.value)}
                />
                <small>An absolute or ~/ path on the machine.</small>
              </label>
            )}
            <div className="field">
              <label className="label" htmlFor={`${datalistId}-input`}>
                Resume conversation ID
              </label>
              <div className="conversation-id-row">
                <input
                  id={`${datalistId}-input`}
                  name="conversation"
                  maxLength={128}
                  spellCheck={false}
                  list={rememberedForTool.length ? datalistId : undefined}
                  placeholder="Auto — start a fresh conversation"
                  value={conversation}
                  onChange={event => setConversation(event.target.value)}
                />
                {conversation.trim() && (
                  <button
                    type="button"
                    className="button small"
                    title="Clear to start a fresh conversation on next start"
                    onClick={() => setConversation('')}
                  >
                    <X size={13} />
                    Start fresh
                  </button>
                )}
              </div>
              {rememberedForTool.length > 0 && (
                <datalist id={datalistId}>
                  {rememberedForTool.map(item => (
                    <option key={item.id} value={item.id} />
                  ))}
                </datalist>
              )}
              <div className="start-command-preview">
                <span className="preview-label">Start command</span>
                <code>{preview.command}</code>
                <small>{preview.note}</small>
              </div>
            </div>
            {supportsTerminal(tool) && (
              <label className="check">
                <input
                  type="checkbox"
                  name="delivery"
                  checked={delivery === 'auto'}
                  onChange={event => setDelivery(event.target.checked ? 'auto' : 'manual')}
                />
                <span>
                  Type messages from other sessions into the terminal
                  <small className="hint">
                    When the agent is idle and you are not typing. Otherwise they wait until you choose Deliver now.
                  </small>
                </span>
              </label>
            )}
            <LaunchFields tool={tool} value={launch} onChange={setLaunch} />
          </fieldset>
        ) : (
          <label className="field">
            <span className="label">Settings</span>
            <textarea
              className="source-editor"
              aria-label="Settings source"
              autoFocus
              spellCheck={false}
              disabled={busy}
              value={source}
              onChange={event => setSource(event.target.value)}
            />
            <small>
              JSON with name, tool, rootDir, conversation (or null), delivery ("auto" or "manual"), instructions, model,
              mode, mcpServers, args and env.
            </small>
          </label>
        )}
        {running && (
          <p className="hint">
            Changes to harness, directory, conversation ID, or launch settings require closing and restarting the
            running session; you’ll be asked whether to restart right after saving.
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
