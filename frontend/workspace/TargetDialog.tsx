import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import MachineSetupGuide from './MachineSetupGuide'
import {
  machineSetupLabels,
  type Environment,
  type Target,
  type TargetInput,
  type TargetUpdate,
} from '../../shared/model'
import { api } from '../api'
import { useAuth } from '../auth/useAuth'
import { Dialog } from '../ui/Dialog'
import AccountKey from '../auth/AccountKey'

/** Add a target, or rename an existing one. */
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
    if (kind === 'local') setKind('ssh')
    setChoosing(true)
  }

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
      if (target) await onSave({ name: text('name') })
      else if (kind !== 'ssh') await onSave({ kind, name: text('name') })
      else
        await onSave({
          kind,
          name: text('name'),
          host: text('host'),
          user: text('user'),
          ...(text('port') ? { port: Number(text('port')) } : {}),
          ...(text('jumpHost') && {
            jump: {
              host: text('jumpHost'),
              user: text('jumpUser') || text('user'),
              ...(text('jumpPort') && { port: Number(text('jumpPort')) }),
            },
          }),
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
            <button key="save" className="button primary" type="submit" form="target-form" disabled={busy}>
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
            onLocal={() => {
              setKind('local')
              setChoosing(false)
            }}
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
                <small>
                  Sessions run as this Linux user. First setup needs the machine ownership directory provisioned for
                  this account or permission to create it with sudo.
                </small>
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
              <details>
                <summary>Use an SSH bastion</summary>
                <label className="field">
                  <span className="label">Bastion host</span>
                  <input name="jumpHost" defaultValue={draft.jumpHost} autoCapitalize="off" spellCheck={false} />
                </label>
                <div className="form-row">
                  <label className="field grow">
                    <span className="label">Bastion user</span>
                    <input name="jumpUser" defaultValue={draft.jumpUser} placeholder="Same as the machine user" />
                  </label>
                  <label className="field port">
                    <span className="label">Bastion port</span>
                    <input
                      name="jumpPort"
                      type="number"
                      min={1}
                      max={65535}
                      defaultValue={draft.jumpPort}
                      placeholder="22"
                    />
                  </label>
                </div>
                {hosted && <small>Authorize your account key on both the bastion and the machine.</small>}
              </details>
              {hosted && <AccountKey />}
            </>
          )}
          {!target && kind === 'outbound' && (
            <p className="hint">
              After adding the machine, copy the install command from its machine page and run it on the machine.
            </p>
          )}
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
