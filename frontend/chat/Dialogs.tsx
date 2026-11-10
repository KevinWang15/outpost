import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Play, Trash2 } from 'lucide-react'
import type { DirectorySuggestions, SessionInput } from '../../shared/model'
import { harnessLabel } from '../../shared/harnesses'
import { describeCron, nextRun, parseCron } from '../../shared/cron'
import { sessionKey, type ChannelView, type SessionRef } from '../../shared/chatApi'
import type { SessionCreationOptions } from '../../shared/sessionCreation'
import ConnectDialog from '../connect/ConnectDialog'
import { useConnect } from '../connect/useConnect'
import { Dialog } from '../ui/Dialog'
import SessionDialog from '../workspace/SessionDialog'
import { plainRef } from './client'
import { Avatar } from './Avatar'
import { useChat } from './context'

function Footer({
  busy,
  onClose,
  action,
  form,
  danger,
}: {
  busy: boolean
  onClose: () => void
  action: string
  form: string
  danger?: React.ReactNode
}) {
  return (
    <>
      {danger}
      <button className="button" type="button" disabled={busy} onClick={onClose}>
        Cancel
      </button>
      <button className="button primary" form={form} disabled={busy}>
        {busy ? 'Saving…' : action}
      </button>
    </>
  )
}

export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const { client, select } = useChat()
  const [targetId, setTargetId] = useState(client.targets[0]?.id ?? '')
  const [loaded, setLoaded] = useState<{
    targetId: string
    options: SessionCreationOptions | null
    problem: string
  } | null>(null)
  const [instructions, setInstructions] = useState('')
  const requestId = useRef(crypto.randomUUID())
  useEffect(() => {
    if (!targetId) return
    let current = true
    client.call<SessionCreationOptions>({ type: 'session-options', targetId }).then(
      options => current && setLoaded({ targetId, options, problem: '' }),
      error => current && setLoaded({ targetId, options: null, problem: (error as Error).message }),
    )
    return () => {
      current = false
    }
  }, [client, targetId])
  const options = loaded?.targetId === targetId ? loaded.options : null
  const problem = loaded?.targetId === targetId ? loaded.problem : ''
  const directories = useCallback(
    (path: string) => client.call<DirectorySuggestions>({ type: 'directories', targetId, path }),
    [client, targetId],
  )
  const target = client.targets.find(item => item.id === targetId) ?? null
  return (
    <SessionDialog
      target={options ? target : null}
      tools={options?.tools ?? []}
      conversation={null}
      directories={directories}
      description={target ? `On ${target.name}. Opens in chat; you can continue it in a terminal any time.` : undefined}
      beforeFields={
        <>
          <label className="field">
            <span className="label">Machine</span>
            <select value={targetId} onChange={event => setTargetId(event.target.value)}>
              {client.targets.map(item => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {!options && !problem && targetId && (
            <p className="muted">
              <LoaderCircle size={14} className="spin" /> Checking the coding tools on {target?.name}…
            </p>
          )}
          {problem && <p className="error">{problem}</p>}
          {options && options.missing.length > 0 && (
            <p className="warning">Install {options.missing.join(', ')} on this machine in Terminal mode first.</p>
          )}
        </>
      }
      afterFields={
        <label className="field">
          <span className="label">Instructions</span>
          <textarea
            rows={3}
            maxLength={32000}
            value={instructions}
            onChange={event => setInstructions(event.target.value)}
            placeholder="Optional. A role or rules for this session, e.g. “You review pull requests. Be concise.”"
          />
          <small>Added to the coding tool’s own instructions in chat. Claude Code and Codex support this.</small>
        </label>
      }
      onSave={async (input: SessionInput) => {
        const created = await client.call<SessionRef>({
          type: 'session-create',
          targetId,
          requestId: requestId.current,
          input,
          instructions: instructions.trim() || null,
        })
        select({ kind: 'session', ...created })
        onClose()
      }}
      onClose={onClose}
    />
  )
}

export function InstructionsDialog({ target: selected, onClose }: { target: SessionRef; onClose: () => void }) {
  const { client } = useChat()
  const target = plainRef(selected)
  const session = client.session(target)
  const [text, setText] = useState(session?.instructions ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const running = session?.driver === 'chat'
  async function save(restart: boolean) {
    setBusy(true)
    setError('')
    try {
      await client.call({ type: 'instructions', ...target, instructions: text.trim() || null })
      if (restart) {
        await client.call({ type: 'stop', ...target })
        client.restart(target)
      }
      onClose()
    } catch (problem) {
      setError((problem as Error).message)
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="Session instructions"
      description={
        session ? `Added to ${harnessLabel(session.tool)}’s own instructions when this chat starts.` : undefined
      }
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button className="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          {running && (
            <button className="button" disabled={busy} onClick={() => void save(true)}>
              Save and restart
            </button>
          )}
          <button className="button primary" disabled={busy} onClick={() => void save(false)}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="form">
        <textarea
          rows={8}
          maxLength={32000}
          value={text}
          autoFocus
          onChange={event => setText(event.target.value)}
          placeholder="You are the release manager. Keep answers short and list risks first."
        />
        {running && (
          <p className="hint">
            The running chat keeps its current instructions until it restarts. The conversation continues either way.
          </p>
        )}
        {session?.tool === 'kimi' && (
          <p className="warning">Kimi Code does not accept session instructions over ACP yet.</p>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </Dialog>
  )
}

export function ChannelDialog({ channelId, onClose }: { channelId: string | null; onClose: () => void }) {
  const { client, select } = useChat()
  const existing = channelId ? client.channels.get(channelId) : undefined
  const [name, setName] = useState(existing?.name ?? '')
  const [topic, setTopic] = useState(existing?.topic ?? '')
  const [members, setMembers] = useState<Set<string>>(new Set(existing?.members.map(sessionKey) ?? []))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const refs = [...members].map(key => {
        const index = key.lastIndexOf('/')
        return { targetId: key.slice(0, index), sessionId: key.slice(index + 1) }
      })
      const saved = await client.call<ChannelView>({
        type: 'channel-save',
        channel: { ...(existing ? { id: existing.id } : {}), name, topic, members: refs },
      })
      select({ kind: 'channel', channelId: saved.id })
      onClose()
    } catch (problem) {
      setError((problem as Error).message)
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={existing ? `#${existing.name}` : 'New channel'}
      description="Members reply when they are mentioned. A reply that mentions another member passes the conversation on."
      busy={busy}
      onClose={onClose}
      footer={
        <Footer
          busy={busy}
          onClose={onClose}
          action={existing ? 'Save' : 'Create channel'}
          form="channel-form"
          danger={
            existing && (
              <button
                className={`button ${confirmDelete ? 'danger' : ''} push-left`}
                type="button"
                disabled={busy}
                onClick={async () => {
                  if (!confirmDelete) return setConfirmDelete(true)
                  setBusy(true)
                  try {
                    await client.call({ type: 'channel-delete', channelId: existing.id })
                    select(null)
                    onClose()
                  } catch (problem) {
                    setError((problem as Error).message)
                    setBusy(false)
                  }
                }}
              >
                <Trash2 size={14} /> {confirmDelete ? 'Delete channel and messages' : 'Delete'}
              </button>
            )
          }
        />
      }
    >
      <form id="channel-form" className="form" onSubmit={submit}>
        <label className="field">
          <span className="label">Name</span>
          <div className="prefixed">
            <span>#</span>
            <input
              required
              autoFocus
              value={name}
              maxLength={40}
              pattern="[a-z0-9][a-z0-9_\-]*"
              placeholder="release"
              onChange={event =>
                setName(
                  event.target.value
                    .toLowerCase()
                    .replace(/\s+/g, '-')
                    .replace(/[^a-z0-9_-]/g, ''),
                )
              }
            />
          </div>
        </label>
        <label className="field">
          <span className="label">Topic</span>
          <input
            value={topic}
            maxLength={500}
            placeholder="Ship version 1.2"
            onChange={event => setTopic(event.target.value)}
          />
        </label>
        <fieldset className="field">
          <legend className="label">Members</legend>
          <div className="member-picker">
            {client.targets.map(target => {
              const list = client.sessions.filter(session => session.targetId === target.id)
              if (!list.length) return null
              return (
                <div key={target.id}>
                  {client.targets.length > 1 && <h4>{target.name}</h4>}
                  {list.map(session => {
                    const key = sessionKey({ targetId: session.targetId, sessionId: session.id })
                    return (
                      <label key={key} className="member-option">
                        <input
                          type="checkbox"
                          checked={members.has(key)}
                          onChange={event => {
                            const next = new Set(members)
                            if (event.target.checked) next.add(key)
                            else next.delete(key)
                            setMembers(next)
                          }}
                        />
                        <Avatar id={session.id} name={session.name} tool={session.tool} size={26} />
                        <span>
                          <strong>{session.name}</strong>
                          <small>
                            @{session.handle} · {harnessLabel(session.tool)}
                          </small>
                        </span>
                      </label>
                    )
                  })}
                </div>
              )
            })}
            {!client.sessions.length && <p className="muted">Create a session first.</p>}
          </div>
        </fieldset>
        {error && <p className="error">{error}</p>}
      </form>
    </Dialog>
  )
}

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
      const index = target.lastIndexOf('/')
      await client.call({
        type: 'schedule-save',
        schedule: {
          ...(existing ? { id: existing.id } : {}),
          name,
          targetId: target.slice(0, index),
          sessionId: target.slice(index + 1),
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
        <Footer
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

/** The browser's terminal chooser (web terminal or Outpost Desktop). It needs the
 * browser login, so Outpost Desktop's chat window uses its bridge instead. */
function BrowserConnect({ target, onClose }: { target: SessionRef; onClose: () => void }) {
  const { client } = useChat()
  const session = client.session(target)
  const connector = useConnect({ id: target.targetId, name: session?.target ?? '' }, onClose)
  const { connect } = connector
  useEffect(() => {
    if (session) connect(session)
    // Connect once, when the chooser opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!session || !connector.connection) return null
  return (
    <ConnectDialog
      target={{ name: session.target }}
      connection={connector.connection}
      onChoose={connector.choose}
      onBack={connector.back}
      onClose={connector.close}
    />
  )
}

/** Move a conversation to a terminal: end the chat's process, then connect. */
export function TerminalDialog({ target: selected, onClose }: { target: SessionRef; onClose: () => void }) {
  const { client, bridge } = useChat()
  const target = plainRef(selected)
  const session = client.session(target)
  const info = client.conversations.get(sessionKey(target))?.info
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(session?.driver !== 'chat')
  const [connecting, setConnecting] = useState(false)
  const working = info?.activity.state === 'working' || info?.activity.state === 'waiting'
  if (!session) return null
  if (connecting) return <BrowserConnect target={target} onClose={onClose} />
  return (
    <Dialog
      title={ready ? `Open ${session.name} in a terminal` : `Continue ${session.name} in a terminal?`}
      description={
        ready
          ? 'The same conversation continues in the coding tool’s own terminal interface.'
          : `This ends the chat’s ${harnessLabel(session.tool)} process. The conversation stays and continues in the terminal.`
      }
      size="small"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <button className="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          {ready ? (
            <button
              className="button primary"
              disabled={busy}
              onClick={() => {
                if (!bridge) return setConnecting(true)
                setBusy(true)
                bridge.openTerminal(target.targetId, target.sessionId).then(onClose, problem => {
                  setError((problem as Error).message)
                  setBusy(false)
                })
              }}
            >
              Open terminal
            </button>
          ) : (
            <button
              className={`button ${working ? 'danger' : 'primary'}`}
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError('')
                try {
                  await client.call({ type: 'stop', ...target })
                  setReady(true)
                } catch (problem) {
                  setError((problem as Error).message)
                }
                setBusy(false)
              }}
            >
              {working ? 'Stop the current work and continue' : 'Continue in a terminal'}
            </button>
          )}
        </>
      }
    >
      {working && !ready && (
        <p className="warning">{session.name} is working now. Stopping it interrupts the current turn.</p>
      )}
      {error && <p className="error">{error}</p>}
    </Dialog>
  )
}
