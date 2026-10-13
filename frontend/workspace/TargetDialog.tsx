import { useEffect, useState, type FormEvent } from 'react'
import { Monitor, Server } from 'lucide-react'
import type { Environment, Target, TargetInput, TargetUpdate } from '../../shared/model'
import { harnesses, type HarnessId } from '../../shared/harnesses'
import { api } from '../api'
import { useAuth } from '../auth/useAuth'
import { Dialog } from '../ui/Dialog'
import AccountKey from '../auth/AccountKey'

function ToolChoice({ value, onChange }: { value: HarnessId[]; onChange: (tools: HarnessId[]) => void }) {
  return <fieldset className="field">
    <legend className="label">Coding tools</legend>
    <div className="toggle-group">
      {harnesses.map(harness => <label key={harness.id} className="toggle">
        <input type="checkbox" checked={value.includes(harness.id)}
          onChange={event => onChange(event.target.checked ? [...value, harness.id] : value.filter(tool => tool !== harness.id))} />
        {harness.label}
      </label>)}
    </div>
    <small>Sessions on this target can use these tools. You can change this later.</small>
  </fieldset>
}

/** Add a target, or edit an existing one's name and tools. */
export default function TargetDialog({ target, onSave, onClose }: {
  target?: Target
  onSave: (input: TargetInput | TargetUpdate) => Promise<void>
  onClose: () => void
}) {
  const hosted = useAuth().mode === 'hosted'
  const [environment, setEnvironment] = useState<Environment | null>(null)
  const [kind, setKind] = useState<'ssh' | 'local'>(target?.kind ?? 'ssh')
  const [tools, setTools] = useState<HarnessId[]>(target?.tools ?? ['claude'])
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
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
    setBusy(true); setError('')
    try {
      if (target) await onSave({ name: text('name'), tools })
      else if (kind === 'local') await onSave({ kind, name: text('name'), tools })
      else await onSave({
        kind, name: text('name'), host: text('host'), tools,
        ...(text('port') ? { port: Number(text('port')) } : {}),
        ...(text('identityFile') ? { identityFile: text('identityFile') } : {}),
      })
    } catch (problem) { setError((problem as Error).message); setBusy(false) }
  }

  return <Dialog title={target ? `Edit ${target.name}` : 'Add a target'} busy={busy} onClose={onClose}
    description={target ? undefined : 'A Linux machine where your coding sessions run.'}
    footer={<>
      <button className="button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
      <button className="button primary" form="target-form" disabled={busy || !tools.length}>{busy ? 'Saving…' : target ? 'Save' : 'Add target'}</button>
    </>}>
    <form id="target-form" className="form" onSubmit={submit}>
      {!target && environment?.localTargets && <div className="segmented" role="radiogroup" aria-label="Target type">
        <button type="button" role="radio" aria-checked={kind === 'ssh'} onClick={() => setKind('ssh')}><Server size={16} />SSH server</button>
        <button type="button" role="radio" aria-checked={kind === 'local'} onClick={() => setKind('local')}><Monitor size={16} />This computer</button>
      </div>}
      <label className="field"><span className="label">Name</span>
        <input name="name" required maxLength={80} autoFocus defaultValue={target?.name} placeholder={kind === 'local' ? 'This computer' : 'dev-box'} />
      </label>
      {!target && kind === 'ssh' && <>
        <div className="form-row">
          <label className="field grow"><span className="label">Host</span>
            <input name="host" required spellCheck={false} autoCapitalize="off" placeholder={hosted ? 'dev.example.com' : 'dev.example.com or an SSH alias'} />
          </label>
          <label className="field port"><span className="label">Port</span>
            <input name="port" type="number" min={1} max={65535} placeholder="22" />
          </label>
        </div>
        {!hosted && <label className="field"><span className="label">Identity file <em>optional</em></span>
          <input name="identityFile" spellCheck={false} placeholder="~/.ssh/id_ed25519" />
          <small>Outpost connects as root using your SSH config and agent.</small>
        </label>}
        {hosted && <AccountKey />}
      </>}
      {!target && kind === 'local' && <p className="hint">Sessions run as your user on the computer running Outpost.</p>}
      <ToolChoice value={tools} onChange={setTools} />
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  </Dialog>
}
