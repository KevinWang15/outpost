import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { SessionCreatorSetup } from '../../desktop/src/session-creator-api'
import type { DesktopTarget } from '../../shared/desktopAuth'
import type { SessionCreationOptions } from '../../shared/sessionCreation'
import { Dialog } from '../ui/Dialog'
import SessionDialog from '../workspace/SessionDialog'

const api = window.outpostSessionCreator
const message = (error: unknown) => (error instanceof Error ? error.message : 'Could not contact this server.')
const cancel = () => api.cancel()
type Loaded<T> = { kind: 'ready'; value: T } | { kind: 'error'; message: string }

export default function SessionCreatorPage() {
  const [setup, setSetup] = useState<SessionCreatorSetup | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void api
      .setup()
      .then(value => {
        if (active) setSetup(value)
      })
      .catch(error => {
        if (active) setError(message(error))
      })
    return () => {
      active = false
    }
  }, [])
  if (setup) return <ChooseServer setup={setup} />
  return (
    <Dialog
      title="New Outpost session"
      onClose={cancel}
      footer={
        <button className="button" onClick={cancel}>
          Cancel
        </button>
      }
    >
      <p role={error ? 'alert' : 'status'}>{error || 'Loading your logged-in servers…'}</p>
    </Dialog>
  )
}

function ChooseServer({ setup }: { setup: SessionCreatorSetup }) {
  const [server, setServer] = useState(() =>
    setup.servers.some(item => item.origin === setup.defaults.server)
      ? setup.defaults.server!
      : setup.servers.length === 1
        ? setup.servers[0].origin
        : '',
  )
  return (
    <CreateOnServer
      key={server}
      server={server}
      defaultTarget={server === setup.defaults.server ? setup.defaults.targetId : undefined}
      serverField={
        <label className="field">
          <span className="label">Outpost server</span>
          <select value={server} onChange={event => setServer(event.target.value)} required autoFocus={!server}>
            <option value="" disabled>
              Choose a logged-in server
            </option>
            {setup.servers.map(item => (
              <option key={item.origin} value={item.origin}>
                {item.origin} · {item.account.name}
              </option>
            ))}
          </select>
          {!setup.servers.length && <small>Sign in to an Outpost server from the Outpost tab first.</small>}
        </label>
      }
    />
  )
}

function CreateOnServer({
  server,
  defaultTarget,
  serverField,
}: {
  server: string
  defaultTarget?: string
  serverField: ReactNode
}) {
  const [targetList, setTargetList] = useState<Loaded<DesktopTarget[]> | null>(null)
  const targets = targetList?.kind === 'ready' ? targetList.value : null
  const targetsError = targetList?.kind === 'error' ? targetList.message : ''
  const [targetChoice, setTargetChoice] = useState(defaultTarget ?? '')
  const [targetsRetry, setTargetsRetry] = useState(0)
  const [optionsRetry, setOptionsRetry] = useState(0)
  const [inspection, setInspection] = useState<({ targetId: string } & Loaded<SessionCreationOptions>) | null>(null)
  const target = targets?.find(item => item.id === targetChoice) ?? (targets?.length === 1 ? targets[0] : undefined)
  const targetId = target?.id ?? ''
  const currentInspection = inspection?.targetId === targetId ? inspection : null
  const options = currentInspection?.kind === 'ready' ? currentInspection.value : undefined
  const optionsError = currentInspection?.kind === 'error' ? currentInspection.message : ''

  useEffect(() => {
    if (!server) return
    let active = true
    void api
      .targets(server)
      .then(value => {
        if (active) setTargetList({ kind: 'ready', value })
      })
      .catch(error => {
        if (active) setTargetList({ kind: 'error', message: message(error) })
      })
    return () => {
      active = false
    }
  }, [server, targetsRetry])
  useEffect(() => {
    if (!server || !targetId) return
    let active = true
    void api
      .options({ server, targetId })
      .then(value => {
        if (active) setInspection({ targetId, kind: 'ready', value })
      })
      .catch(error => {
        if (active) setInspection({ targetId, kind: 'error', message: message(error) })
      })
    return () => {
      active = false
    }
  }, [server, targetId, optionsRetry])
  const directories = useCallback(
    async (path: string, signal: AbortSignal) => {
      signal.throwIfAborted()
      const result = await api.directories({ server, targetId }, path)
      signal.throwIfAborted()
      return result
    },
    [server, targetId],
  )
  function reload() {
    setInspection(null)
    if (targetsError) {
      setTargetList(null)
      setTargetsRetry(value => value + 1)
    } else setOptionsRetry(value => value + 1)
  }
  const ready = !!options && options.missing.length === 0 && options.tools.length > 0
  return (
    <SessionDialog
      key={targetId}
      target={ready ? target! : null}
      tools={options?.tools ?? []}
      conversation={null}
      directories={directories}
      onClose={cancel}
      onSave={input => api.create({ server, targetId }, input)}
      beforeFields={
        <>
          {serverField}
          {server && (
            <label className="field">
              <span className="label">Execution target</span>
              <select
                required
                value={targetId}
                disabled={!targets?.length}
                onChange={event => {
                  // Re-selecting a target must inspect it again, even if its
                  // previous result was the last request to finish.
                  setInspection(null)
                  setTargetChoice(event.target.value)
                }}
              >
                <option value="" disabled>
                  Choose a target
                </option>
                {targets?.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {server && !targets && !targetsError && (
            <p className="hint" role="status">
              Loading targets…
            </p>
          )}
          {targets?.length === 0 && (
            <p className="hint">Add an execution target in this server's Outpost web workspace first.</p>
          )}
          {target && !options && !optionsError && (
            <p className="hint" role="status">
              Checking the target's required software…
            </p>
          )}
          {(targetsError || optionsError) && (
            <p className="error" role="alert">
              {targetsError || optionsError}
            </p>
          )}
          {options && !ready && (
            <p className="hint">
              Install the required software in this target's Outpost web workspace:{' '}
              {options.missing.join(', ') || 'a coding tool'}.
            </p>
          )}
          {(targetsError || optionsError || (options && !ready)) && (
            <button type="button" className="button small" onClick={reload}>
              Check again
            </button>
          )}
        </>
      }
    />
  )
}
