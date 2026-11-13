import { useRef, useState, type FormEvent } from 'react'
import { ChevronRight, Plus, Send, Trash2 } from 'lucide-react'
import {
  logKindLabels,
  logKinds,
  type LogKind,
  type LogLevel,
  type Webhook,
  type WebhookDelivery,
  type WebhookInput,
} from '../../shared/logs'
import { api } from '../api'
import { Dialog } from '../ui/Dialog'

const levelLabels: Record<LogLevel, string> = {
  info: 'Everything',
  warning: 'Warnings and errors',
  error: 'Errors only',
}

const example = JSON.stringify(
  {
    version: 1,
    webhook: { id: '…', name: 'Team alerts' },
    event: {
      id: '…',
      time: '2026-11-14T09:30:00.000Z',
      level: 'info',
      kind: 'agent',
      type: 'status',
      message: 'Billing API finished its turn',
      machine: { id: '…', name: 'Workstation' },
      session: { id: '…', name: 'Billing API' },
      details: { state: 'finished', previous: 'working', detail: null },
    },
  },
  null,
  2,
)

function deliveryText(delivery: WebhookDelivery) {
  return delivery.ok ? `Delivered${delivery.status ? ` (${delivery.status})` : ''}.` : (delivery.error ?? 'Failed.')
}

/** Create or edit a webhook. Saved header values are never shown again; leaving
 * one empty keeps it. */
export default function WebhookDialog({
  webhook,
  onSaved,
  onDeleted,
  onClose,
}: {
  webhook: Webhook | null
  onSaved: (webhook: Webhook) => void
  onDeleted: (id: string) => void
  onClose: () => void
}) {
  const [kinds, setKinds] = useState<LogKind[]>(webhook?.kinds ?? [])
  const nextHeader = useRef(webhook?.headers.length ?? 0)
  const [headers, setHeaders] = useState(() =>
    (webhook?.headers ?? []).map((header, id) => ({ id, name: header.name, saved: true })),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [test, setTest] = useState<WebhookDelivery | null>(null)
  const [confirming, setConfirming] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const names = data.getAll('headerName').map(String)
    const values = data.getAll('headerValue').map(String)
    const input: WebhookInput = {
      name: String(data.get('name')).trim(),
      url: String(data.get('url')).trim(),
      headers: names.map((name, index) => {
        const saved = headers[index]?.saved && headers[index].name === name
        return saved && !values[index] ? { name } : { name, value: values[index] }
      }),
      kinds,
      level: data.get('level') as LogLevel,
      enabled: data.get('enabled') === 'on',
    }
    setBusy(true)
    setError('')
    try {
      onSaved(
        webhook
          ? await api<Webhook>(`/webhooks/${webhook.id}`, 'PUT', input)
          : await api<Webhook>('/webhooks', 'POST', input),
      )
    } catch (problem) {
      setError((problem as Error).message)
      setBusy(false)
    }
  }

  async function sendTest() {
    if (!webhook) return
    setBusy(true)
    setTest(null)
    setError('')
    try {
      setTest(await api<WebhookDelivery>(`/webhooks/${webhook.id}/test`, 'POST'))
    } catch (problem) {
      setError((problem as Error).message)
    }
    setBusy(false)
  }

  async function remove() {
    if (!webhook) return
    setBusy(true)
    try {
      await api(`/webhooks/${webhook.id}`, 'DELETE')
      onDeleted(webhook.id)
    } catch (problem) {
      setError((problem as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={webhook ? `Edit ${webhook.name}` : 'New webhook'}
      description="Outpost sends matching log events to this address as they happen, one POST each."
      busy={busy}
      onClose={onClose}
      footer={
        <>
          {webhook &&
            (confirming ? (
              <button className="button danger push-left" type="button" disabled={busy} onClick={() => void remove()}>
                Delete webhook
              </button>
            ) : (
              <button className="button push-left" type="button" disabled={busy} onClick={() => setConfirming(true)}>
                <Trash2 size={14} /> Delete
              </button>
            ))}
          {webhook && (
            <button className="button" type="button" disabled={busy} onClick={() => void sendTest()}>
              <Send size={14} /> Send a test
            </button>
          )}
          <button className="button" type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" form="webhook-form" disabled={busy}>
            {busy ? 'Saving…' : webhook ? 'Save' : 'Create webhook'}
          </button>
        </>
      }
    >
      <form id="webhook-form" className="form" onSubmit={event => void submit(event)}>
        <label className="field">
          <span className="label">Name</span>
          <input name="name" required maxLength={80} autoFocus defaultValue={webhook?.name} placeholder="Team alerts" />
        </label>
        <label className="field">
          <span className="label">URL</span>
          <input
            name="url"
            type="url"
            required
            maxLength={2048}
            defaultValue={webhook?.url}
            placeholder="https://example.com/hooks/outpost"
          />
          <small>Outpost sends a POST with a JSON body. It does not follow redirects.</small>
        </label>
        <div className="field">
          <span className="label">Headers</span>
          {headers.map((header, index) => (
            <div className="env-row" key={header.id}>
              <input
                name="headerName"
                aria-label={`Header ${index + 1} name`}
                required
                maxLength={100}
                pattern="[!#$%&'*+.^_`|~0-9A-Za-z\-]+"
                placeholder="Authorization"
                spellCheck={false}
                defaultValue={header.name}
              />
              <input
                name="headerValue"
                aria-label={`Header ${index + 1} value`}
                maxLength={4096}
                required={!header.saved}
                placeholder={header.saved ? 'Saved; leave empty to keep it' : 'Bearer …'}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove header ${index + 1}`}
                onClick={() => setHeaders(rows => rows.filter(row => row.id !== header.id))}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button small"
            disabled={headers.length >= 16}
            onClick={() => setHeaders(rows => [...rows, { id: nextHeader.current++, name: '', saved: false }])}
          >
            <Plus size={14} /> Add header
          </button>
          <small>Sent with every request, e.g. a token the receiver checks. Values are not shown again.</small>
        </div>
        <fieldset className="field">
          <legend className="label">Events</legend>
          <div className="toggle-group">
            <label className="toggle">
              <input type="checkbox" checked={!kinds.length} onChange={() => setKinds([])} />
              All
            </label>
            {logKinds.map(kind => (
              <label key={kind} className="toggle">
                <input
                  type="checkbox"
                  checked={kinds.includes(kind)}
                  onChange={event =>
                    setKinds(list => (event.target.checked ? [...list, kind] : list.filter(item => item !== kind)))
                  }
                />
                {logKindLabels[kind]}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field">
          <span className="label">Send</span>
          <select name="level" defaultValue={webhook?.level ?? 'info'}>
            {Object.entries(levelLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" name="enabled" defaultChecked={webhook?.enabled ?? true} />
          Send events to this webhook
        </label>
        <details className="disclosure">
          <summary>
            <ChevronRight size={14} />
            Request body
          </summary>
          <pre className="webhook-example">{example}</pre>
          <small className="hint">
            <code>kind</code> is one of {logKinds.join(', ')}; <code>level</code> is info, warning or error.
          </small>
        </details>
        {webhook?.lastDelivery && !test && (
          <p className={webhook.lastDelivery.ok ? 'muted' : 'warning'} role="status">
            Last delivery: {deliveryText(webhook.lastDelivery)}
          </p>
        )}
        {test && (
          <p className={test.ok ? 'muted' : 'warning'} role="status">
            Test: {deliveryText(test)}
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
