import { useEffect, useState, type FormEvent } from 'react'
import {
  machineSetupLabels,
  type Environment,
  type Target,
  type TargetInput,
  type TargetUpdate,
} from '../../shared/model'
import { harnesses, supportsTerminal, type HarnessId } from '../../shared/harnesses'
import { api } from '../api'
import { useAuth } from '../auth/useAuth'
import { Dialog } from '../ui/Dialog'
import AccountKey from '../auth/AccountKey'

const connectionSetups = [
  { kind: 'ssh', detail: 'Use when your Outpost server can SSH into the machine. You connect through the server.' },
  {
    kind: 'direct',
    detail:
      'Your browser or desktop app connects to the machine over HTTPS, for example on a company VPN. The machine stays disconnected from the Outpost server.',
  },
  {
    kind: 'paired',
    detail:
      'Use when the machine can connect out to your Outpost server. Clients can connect directly or use the server as a relay.',
  },
  { kind: 'local', detail: 'Run sessions on the same Linux machine as the Outpost server.' },
] as const

function ToolChoice({
  value,
  direct,
  onChange,
}: {
  value: HarnessId[]
  direct: boolean
  onChange: (tools: HarnessId[]) => void
}) {
  return (
    <fieldset className="field">
      <legend className="label">Coding tools</legend>
      <div className="toggle-group">
        {harnesses
          .filter(harness => !direct || supportsTerminal(harness.id))
          .map(harness => (
            <label key={harness.id} className="toggle">
              <input
                type="checkbox"
                checked={value.includes(harness.id)}
                onChange={event =>
                  onChange(event.target.checked ? [...value, harness.id] : value.filter(tool => tool !== harness.id))
                }
              />
              {harness.label}
            </label>
          ))}
      </div>
      <small>Sessions on this machine can use these tools. You can change this later.</small>
    </fieldset>
  )
}

/** Add a target, or edit an existing one's name and tools. */
export default function TargetDialog({
  target,
  onSave,
  onClose,
}: {
  target?: Target
  onSave: (input: TargetInput | TargetUpdate) => Promise<void>
  onClose: () => void
}) {
  const hosted = useAuth().mode === 'hosted'
  const [environment, setEnvironment] = useState<Environment | null>(null)
  const [kind, setKind] = useState<Target['kind']>(target?.kind ?? 'ssh')
  const [chosenTools, setTools] = useState<HarnessId[]>(target?.tools ?? ['claude'])
  const tools = kind === 'direct' ? chosenTools.filter(supportsTerminal) : chosenTools
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  useEffect(() => {
    if (target) return
    const controller = new AbortController()
    api<Environment>('/environment', 'GET', undefined, controller.signal).then(setEnvironment, () => {})
    return () => controller.abort()
  }, [target])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const text = (name: string) => String(data.get(name) ?? '').trim()
    setBusy(true)
    setError('')
    try {
      if (target) await onSave({ name: text('name'), tools })
      else if (kind === 'direct') await onSave({ kind, name: text('name'), tools, endpoint: text('endpoint') })
      else if (kind !== 'ssh') await onSave({ kind, name: text('name'), tools })
      else
        await onSave({
          kind,
          name: text('name'),
          host: text('host'),
          user: text('user'),
          tools,
          ...(text('port') ? { port: Number(text('port')) } : {}),
          ...(text('identityFile') ? { identityFile: text('identityFile') } : {}),
        })
    } catch (problem) {
      setError((problem as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={target ? `Edit ${target.name}` : 'Add a machine'}
      busy={busy}
      onClose={onClose}
      description={target ? undefined : 'A Linux machine where your coding sessions run.'}
      footer={
        <>
          <button className="button" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" form="target-form" disabled={busy || !tools.length}>
            {busy ? 'Saving…' : target ? 'Save' : 'Add machine'}
          </button>
        </>
      }
    >
      <form id="target-form" className="form" onSubmit={submit}>
        {!target && (
          <fieldset className="field">
            <legend className="label">How will you reach this machine?</legend>
            {connectionSetups
              .filter(setup => setup.kind !== 'local' || environment?.localTargets)
              .map(setup => (
                <label className="connection-setup" key={setup.kind}>
                  <input
                    type="radio"
                    name="connection-setup"
                    checked={kind === setup.kind}
                    onChange={() => setKind(setup.kind)}
                    aria-labelledby={`setup-label-${setup.kind}`}
                    aria-describedby={`setup-detail-${setup.kind}`}
                  />
                  <span>
                    <strong id={`setup-label-${setup.kind}`}>{machineSetupLabels[setup.kind]}</strong>
                    <small id={`setup-detail-${setup.kind}`}>{setup.detail}</small>
                  </span>
                </label>
              ))}
          </fieldset>
        )}
        <label className="field">
          <span className="label">Name</span>
          <input
            name="name"
            required
            maxLength={80}
            autoFocus={Boolean(target)}
            defaultValue={target?.name}
            placeholder={kind === 'local' ? machineSetupLabels.local : 'dev-box'}
          />
        </label>
        {!target && kind === 'direct' && (
          <label className="field">
            <span className="label">Machine HTTPS address</span>
            <input required name="endpoint" type="url" placeholder="https://terminal.corp.example" />
            <small>
              Enter the HTTPS endpoint of the Outpost machine service. After adding it, follow the offline enrollment
              instructions on its machine page.
            </small>
          </label>
        )}
        {!target && kind === 'ssh' && (
          <>
            <div className="form-row">
              <label className="field grow">
                <span className="label">Host</span>
                <input
                  name="host"
                  required
                  spellCheck={false}
                  autoCapitalize="off"
                  placeholder={hosted ? 'dev.example.com' : 'dev.example.com or an SSH alias'}
                />
              </label>
              <label className="field port">
                <span className="label">Port</span>
                <input name="port" type="number" min={1} max={65535} placeholder="22" />
              </label>
            </div>
            <label className="field">
              <span className="label">User</span>
              <input name="user" required spellCheck={false} autoCapitalize="off" maxLength={32} placeholder="ubuntu" />
              <small>Sessions run as this Linux user. It needs no root access.</small>
            </label>
            {!hosted && (
              <label className="field">
                <span className="label">
                  Identity file <em>optional</em>
                </span>
                <input name="identityFile" spellCheck={false} placeholder="~/.ssh/id_ed25519" />
                <small>Otherwise Outpost uses your SSH config and agent.</small>
              </label>
            )}
            {hosted && <AccountKey />}
          </>
        )}
        {!target && kind === 'paired' && (
          <p className="hint">After adding the machine, use the pairing code on its machine page to enroll it.</p>
        )}
        <ToolChoice direct={kind === 'direct'} value={tools} onChange={setTools} />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  )
}
