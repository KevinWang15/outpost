import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import MachineSetupGuide from './MachineSetupGuide'
import {
  machineSetupLabels,
  machineEndpoint,
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
  const [choosing, setChoosing] = useState(!target)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const form = useRef<HTMLFormElement>(null)
  const guide = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (choosing) guide.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus()
    else form.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus()
  }, [choosing])

  function back() {
    if (form.current) {
      const fields = Object.fromEntries(new FormData(form.current)) as Record<string, string>
      setDraft(previous => ({ ...previous, ...fields }))
    }
    setError('')
    setChoosing(true)
  }

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
    if (busy) return
    const data = new FormData(event.currentTarget)
    const text = (name: string) => String(data.get(name) ?? '').trim()
    setBusy(true)
    setError('')
    try {
      const connector = kind === 'direct' || kind === 'paired'
      if (target) await onSave({ name: text('name'), tools, ...(connector && { endpoint: text('endpoint') || null }) })
      else if (kind === 'direct') await onSave({ kind, name: text('name'), tools, endpoint: text('endpoint') })
      else if (kind === 'paired')
        await onSave({ kind, name: text('name'), tools, ...(text('endpoint') && { endpoint: text('endpoint') }) })
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
      size={choosing ? 'large' : 'medium'}
      className={target ? '' : 'machine-wizard'}
      description={
        target
          ? undefined
          : choosing
            ? 'Step 1 of 2 · Choose a connection method'
            : `Step 2 of 2 · ${machineSetupLabels[kind]} details`
      }
      footer={
        <>
          <button
            className={target || choosing ? 'button' : 'button push-left'}
            type="button"
            disabled={busy}
            onClick={target || choosing ? onClose : back}
          >
            {target || choosing ? (
              'Cancel'
            ) : (
              <>
                <ArrowLeft size={15} />
                Back
              </>
            )}
          </button>
          {choosing ? (
            <button key="continue" className="button primary" type="button" onClick={() => setChoosing(false)}>
              Continue <ArrowRight size={15} />
            </button>
          ) : (
            <button
              key="save"
              className="button primary"
              type="submit"
              form="target-form"
              disabled={busy || !tools.length}
            >
              {busy ? 'Saving…' : target ? 'Save' : 'Add machine'}
            </button>
          )}
        </>
      }
    >
      {choosing ? (
        <div ref={guide}>
          <MachineSetupGuide
            kind={kind}
            localAvailable={Boolean(environment?.localTargets)}
            hosted={hosted}
            onSelect={setKind}
          />
        </div>
      ) : (
        <form ref={form} id="target-form" className="form" onSubmit={submit}>
          <label className="field">
            <span className="label">Name</span>
            <input
              name="name"
              required
              maxLength={80}
              defaultValue={draft.name ?? target?.name}
              placeholder={kind === 'local' ? machineSetupLabels.local : 'dev-box'}
            />
          </label>
          {(kind === 'direct' || kind === 'paired') && (
            <label className="field">
              <span className="label">Machine HTTPS address {kind === 'paired' && <em>optional</em>}</span>
              <input
                required={kind === 'direct'}
                name="endpoint"
                defaultValue={draft.endpoint ?? (target && machineEndpoint(target))}
                type="url"
                placeholder="https://terminal.corp.example"
              />
              <small>
                {kind === 'paired'
                  ? 'Set this to try direct connections first. Leave it empty to use the relay.'
                  : 'Your device must be able to reach this address.'}
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
                    defaultValue={draft.host}
                    required
                    spellCheck={false}
                    autoCapitalize="off"
                    placeholder={hosted ? 'dev.example.com' : 'dev.example.com or an SSH alias'}
                  />
                </label>
                <label className="field port">
                  <span className="label">Port</span>
                  <input name="port" defaultValue={draft.port} type="number" min={1} max={65535} placeholder="22" />
                </label>
              </div>
              <label className="field">
                <span className="label">User</span>
                <input
                  name="user"
                  defaultValue={draft.user}
                  required
                  spellCheck={false}
                  autoCapitalize="off"
                  maxLength={32}
                  placeholder="ubuntu"
                />
                <small>Sessions run as this Linux user. It needs no root access.</small>
              </label>
              {!hosted && (
                <label className="field">
                  <span className="label">
                    Identity file <em>optional</em>
                  </span>
                  <input
                    name="identityFile"
                    defaultValue={draft.identityFile}
                    spellCheck={false}
                    placeholder="~/.ssh/id_ed25519"
                  />
                  <small>Otherwise Outpost uses your SSH config and agent.</small>
                </label>
              )}
              {hosted && <AccountKey />}
            </>
          )}
          {!target && kind === 'paired' && (
            <p className="hint">
              After adding the machine, copy the install command from its machine page and run it on the machine.
            </p>
          )}
          <ToolChoice
            direct={kind === 'direct'}
            value={tools}
            onChange={updated =>
              setTools(
                kind === 'direct' ? [...chosenTools.filter(tool => !supportsTerminal(tool)), ...updated] : updated,
              )
            }
          />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </Dialog>
  )
}
