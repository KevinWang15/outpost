import { useState, type FormEvent } from 'react'
import { Braces, ListChecks } from 'lucide-react'
import type { Session, SessionSettings, SessionUpdate } from '../../shared/model'
import { harnessLabel, supportsTerminal } from '../../shared/harnesses'
import { Dialog } from '../ui/Dialog'
import LaunchFields from './LaunchFields'
import { launchDraft, parseSource, readDraft, settingsProblem } from './launch'

const settingsOf = ({ name, delivery, config: { revision: _, ...launch } }: Session): SessionSettings => ({
  name,
  delivery,
  ...launch,
})

/** Edit a session: its name now, its launch configuration at the next start.
 * Edit source shows the same settings as one JSON document. */
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
  const [name, setName] = useState(session.name)
  const [delivery, setDelivery] = useState(session.delivery)
  const [launch, setLaunch] = useState(() => launchDraft(session.config))
  const [source, setSource] = useState<string | null>(null)
  // Remounts the form's fields with what the source said.
  const [generation, setGeneration] = useState(0)
  const running = session.driver !== null

  const fromForm = (): SessionSettings => ({ name: name.trim(), delivery, ...readDraft(launch) })

  function toggleSource() {
    setError('')
    try {
      if (source === null) return setSource(JSON.stringify(fromForm(), null, 2))
      const settings = parseSource(source)
      setName(settings.name)
      setDelivery(settings.delivery)
      setLaunch(launchDraft(settings))
      setGeneration(value => value + 1)
      setSource(null)
    } catch (problem) {
      setError((problem as Error).message)
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>, restart: boolean) {
    event.preventDefault()
    if (busy) return
    setError('')
    try {
      const settings = source === null ? fromForm() : parseSource(source)
      const problem = settingsProblem(settings)
      if (problem) throw new Error(problem)
      const before = settingsOf(session)
      const update: SessionUpdate = { revision: session.config.revision }
      for (const key of Object.keys(settings) as (keyof SessionSettings)[])
        if (JSON.stringify(settings[key]) !== JSON.stringify(before[key]))
          Object.assign(update, { [key]: settings[key] })
      setBusy(true)
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
            {supportsTerminal(session.tool) && (
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
            <LaunchFields tool={session.tool} value={launch} onChange={setLaunch} />
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
              JSON with name, delivery ("auto" types messages from other sessions into the terminal, "manual" holds
              them), instructions, model, mode, mcpServers, args and env. Unset values are null or empty.
            </small>
          </label>
        )}
        {running && (
          <p className="hint">
            The running session keeps its current instructions, model, MCP servers, arguments and environment until it
            restarts. The conversation continues either way.
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
