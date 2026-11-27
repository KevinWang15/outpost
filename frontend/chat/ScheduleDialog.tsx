import { useMemo, useState } from 'react'
import { Play, Trash2 } from 'lucide-react'
import { describeCron, nextRun, parseCron } from '../../shared/cron'
import { parseSessionKey, sessionKey, type SessionRef } from '../../shared/chatApi'
import { Dialog } from '../ui/Dialog'
import { useChat } from './context'
import { DialogFooter } from './Dialogs'

const presets = [
  { id: 'daily', label: 'Every day', cron: (h: number, m: number) => `${m} ${h} * * *` },
  { id: 'weekdays', label: 'Weekdays', cron: (h: number, m: number) => `${m} ${h} * * 1-5` },
  { id: 'weekly', label: 'Every Monday', cron: (h: number, m: number) => `${m} ${h} * * 1` },
  { id: 'hourly', label: 'Every hour', cron: (_h: number, m: number) => `${m} * * * *` },
] as const

export function ScheduleDialog({
  scheduleId,
  session,
  onClose,
}: {
  scheduleId: string | null
  session: SessionRef | null
  onClose: () => void
}) {
  const { client } = useChat()
  const existing = scheduleId ? client.schedules.get(scheduleId) : undefined
  const [name, setName] = useState(existing?.name ?? '')
  const [target, setTarget] = useState(
    existing
      ? sessionKey(existing)
      : session
        ? sessionKey(session)
        : client.sessions[0]
          ? sessionKey({ targetId: client.sessions[0].targetId, sessionId: client.sessions[0].id })
          : '',
  )
  const [prompt, setPrompt] = useState(existing?.prompt ?? '')
  const [cron, setCron] = useState(existing?.cron ?? '0 9 * * 1-5')
  const [timeZone, setTimeZone] = useState(existing?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  const [custom, setCustom] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const time = cron.match(/^(\d+) (\d+|\*) /)
  const [hour, minute] = [time && time[2] !== '*' ? Number(time[2]) : 9, time ? Number(time[1]) : 0]
  const preset = presets.find(item => item.cron(hour, minute) === cron)?.id ?? 'custom'
  const preview = useMemo(() => {
    try {
      const next = nextRun(parseCron(cron), timeZone)
      return next
        ? `Next: ${next.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
        : 'Never runs.'
    } catch (problem) {
      return (problem as Error).message
    }
  }, [cron, timeZone])
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const ref = parseSessionKey(target)
      if (!ref) throw new Error('Choose a target session.')
      await client.call({
        type: 'schedule-save',
        schedule: {
          ...(existing ? { id: existing.id } : {}),
          name,
          targetId: ref.targetId,
          sessionId: ref.sessionId,
          prompt,
          cron,
          timeZone,
          enabled,
        },
      })
      onClose()
    } catch (problem) {
      setError((problem as Error).message)
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={existing ? existing.name : 'New schedule'}
      description="Sends a message to a session at set times, while Outpost is running. Replies appear in that session’s chat."
      busy={busy}
      onClose={onClose}
      footer={
        <DialogFooter
          busy={busy}
          onClose={onClose}
          action={existing ? 'Save' : 'Create schedule'}
          form="schedule-form"
          danger={
            existing && (
              <>
                <button
                  className="button push-left"
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      await client.call({ type: 'schedule-delete', scheduleId: existing.id })
                      onClose()
                    } catch (problem) {
                      setError((problem as Error).message)
                      setBusy(false)
                    }
                  }}
                >
                  <Trash2 size={14} /> Delete
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void client
                      .call({ type: 'schedule-run', scheduleId: existing.id })
                      .catch(problem => setError((problem as Error).message))
                  }
                >
                  <Play size={14} /> Run now
                </button>
              </>
            )
          }
        />
      }
    >
      <form id="schedule-form" className="form" onSubmit={submit}>
        <label className="field">
          <span className="label">Name</span>
          <input
            required
            autoFocus
            maxLength={80}
            value={name}
            placeholder="Morning summary"
            onChange={event => setName(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="label">Session</span>
          <select required value={target} onChange={event => setTarget(event.target.value)}>
            {client.sessions.map(item => (
              <option key={item.id} value={sessionKey({ targetId: item.targetId, sessionId: item.id })}>
                {item.name} · {item.target}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Message</span>
          <textarea
            required
            rows={4}
            maxLength={16384}
            value={prompt}
            placeholder="Summarize what changed on main since yesterday and flag anything risky."
            onChange={event => setPrompt(event.target.value)}
          />
        </label>
        <div className="form-row">
          <label className="field grow">
            <span className="label">Repeat</span>
            <select
              value={custom ? 'custom' : preset}
              onChange={event => {
                const chosen = presets.find(item => item.id === event.target.value)
                setCustom(!chosen)
                if (chosen) setCron(chosen.cron(hour, minute))
              }}
            >
              {presets.map(item => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
              <option value="custom">Custom (cron)</option>
            </select>
          </label>
          {!custom && preset !== 'custom' && (
            <label className="field">
              <span className="label">{preset === 'hourly' ? 'Minute' : 'Time'}</span>
              {preset === 'hourly' ? (
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={minute}
                  onChange={event => setCron(presets[3].cron(hour, Number(event.target.value)))}
                />
              ) : (
                <input
                  type="time"
                  value={`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`}
                  onChange={event => {
                    const [h, m] = event.target.value.split(':').map(Number)
                    setCron(presets.find(item => item.id === preset)!.cron(h, m))
                  }}
                />
              )}
            </label>
          )}
        </div>
        {(custom || preset === 'custom') && (
          <label className="field">
            <span className="label">Cron expression</span>
            <input
              value={cron}
              spellCheck={false}
              pattern="[0-9*,/ \-]+"
              onChange={event => setCron(event.target.value)}
            />
            <small>minute hour day month weekday — {describeCron(cron)}</small>
          </label>
        )}
        <label className="field">
          <span className="label">Time zone</span>
          <input value={timeZone} spellCheck={false} onChange={event => setTimeZone(event.target.value)} />
          <small>{preview}</small>
        </label>
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
          Enabled
        </label>
        {existing?.lastRun && (
          <p className={existing.lastRun.ok ? 'hint' : 'error'}>
            Last run {new Date(existing.lastRun.at).toLocaleString()}:{' '}
            {existing.lastRun.ok ? 'replied' : existing.lastRun.message}
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </form>
    </Dialog>
  )
}
