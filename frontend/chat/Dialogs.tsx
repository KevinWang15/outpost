import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Play, Trash2 } from 'lucide-react'
import type { ConversationMatch, ConversationResults, DirectorySuggestions, SessionInput } from '../../shared/model'
import { softwareLabel } from '../../shared/model'
import { describeCron, nextRun, parseCron } from '../../shared/cron'
import { harnesses, harnessLabel } from '../../shared/harnesses'
import { pagePaths } from '../../shared/pages'
import { chatLimits, sessionKey, type ChannelMember, type ChannelView, type SessionRef } from '../../shared/chatApi'
import type { SessionCreationOptions } from '../../shared/sessionCreation'
import { Dialog } from '../ui/Dialog'
import ConversationsDialog from '../workspace/ConversationsDialog'
import FinderDialog from '../workspace/FinderDialog'
import ForkDialog from '../workspace/ForkDialog'
import SessionDialog from '../workspace/SessionDialog'
import { DeleteConfirm, StopConfirm } from '../workspace/SessionMenu'
import SessionSettingsDialog from '../workspace/SessionSettingsDialog'
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

/** Create a session that starts in chat, or link a conversation found on a machine. */
export function NewSessionDialog({
  machine,
  conversation = null,
  onClose,
}: {
  machine?: string
  conversation?: ConversationMatch | null
  onClose: () => void
}) {
  const { client, select } = useChat()
  const [targetId, setTargetId] = useState(machine ?? client.targets[0]?.id ?? '')
  const [loaded, setLoaded] = useState<{
    targetId: string
    options: SessionCreationOptions | null
    problem: string
  } | null>(null)
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
      tools={options && !options.missing.length ? options.tools : []}
      conversation={conversation}
      directories={directories}
      description={target ? `On ${target.name}. It starts in chat.` : undefined}
      copyFrom={client.sessions.map(session => ({
        key: `${session.targetId}/${session.id}`,
        label: `${session.name} · ${harnessLabel(session.tool)} on ${session.target}`,
        session,
      }))}
      beforeFields={
        <>
          <label className="field">
            <span className="label">Machine</span>
            <select
              value={targetId}
              disabled={Boolean(conversation)}
              onChange={event => setTargetId(event.target.value)}
            >
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
            <p className="warning">
              Set up {options.missing.map(softwareLabel).join(', ')} on {target?.name} first, from{' '}
              <MachineLink targetId={targetId}>its page in Machines</MachineLink>.
            </p>
          )}
          {options && options.missing.length === 0 && options.tools.length === 0 && (
            <p className="warning">
              No coding tools are installed on {target?.name}. Set one up from{' '}
              <MachineLink targetId={targetId}>its page in Machines</MachineLink>.
            </p>
          )}
          {options &&
            options.missing.length === 0 &&
            options.tools.length > 0 &&
            options.tools.length < harnesses.length &&
            !conversation && (
              <p className="hint">
                Need another coding tool? Set it up on{' '}
                <MachineLink targetId={targetId}>{target?.name}’s machine page</MachineLink>.
              </p>
            )}
        </>
      }
      onSave={async (input: SessionInput) => {
        const created = await client.call<SessionRef>({
          type: 'session-create',
          targetId,
          requestId: requestId.current,
          input,
        })
        client.restart(created)
        select({ kind: 'session', ...created })
        onClose()
      }}
      onClose={onClose}
    />
  )
}

export function SessionSettingsChatDialog({ target: selected, onClose }: { target: SessionRef; onClose: () => void }) {
  const { client } = useChat()
  const target = plainRef(selected)
  const session = client.session(target)
  if (!session) return null
  return (
    <SessionSettingsDialog
      session={session}
      onClose={onClose}
      onSave={update => client.call({ type: 'session-update', ...target, update })}
      onRestart={async () => {
        await client.call({ type: 'stop', ...target })
        client.restart(target)
      }}
    />
  )
}

export function ConversationsChatDialog({ target: selected, onClose }: { target: SessionRef; onClose: () => void }) {
  const { client } = useChat()
  const target = plainRef(selected)
  const session = client.session(target)
  if (!session) return null
  return (
    <ConversationsDialog
      session={session}
      whileRunning="Resuming another conversation restarts the coding tool in it."
      onClose={onClose}
      onSwitch={async conversation => {
        if (session.driver) await client.call({ type: 'stop', ...target })
        await client.call({ type: 'session-switch', ...target, conversation })
        client.restart(target)
      }}
    />
  )
}

export function ChannelDialog({
  channelId,
  membersOnly = false,
  onClose,
}: {
  channelId: string | null
  membersOnly?: boolean
  onClose: () => void
}) {
  const { client, select } = useChat()
  const existing = channelId ? client.channels.get(channelId) : undefined
  const [name, setName] = useState(existing?.name ?? '')
  const [topic, setTopic] = useState(existing?.topic ?? '')
  const [changes, setChanges] = useState(new Map<string, boolean>())
  const [search, setSearch] = useState('')
  const current = new Map(existing?.members.map(member => [sessionKey(member), member]))
  // Stored members remain visible and removable even when their machine is offline.
  const candidates = new Map<string, ChannelMember>(current)
  for (const session of client.sessions) {
    const ref = { targetId: session.targetId, sessionId: session.id }
    const key = sessionKey(ref)
    candidates.set(key, { ...ref, name: session.name, handle: current.get(key)?.handle ?? session.handle })
  }
  const selected = (key: string) => changes.get(key) ?? current.has(key)
  const roster = [...candidates].filter(([key]) => selected(key))
  const query = search.trim().toLowerCase()
  const options = [...candidates]
    .map(([key, member]) => {
      const session = client.session(member)
      const target = client.targets.find(target => target.id === member.targetId)
      const machine = target?.name ?? member.targetId
      const detail = [
        `@${member.handle}`,
        machine,
        target?.error || !session ? 'Unavailable' : harnessLabel(session.tool),
      ].join(' · ')
      return { key, member, session, detail }
    })
    .filter(({ member, detail }) => `${member.name} ${detail}`.toLowerCase().includes(query))

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const channel = !channelId
        ? { name, topic, members: roster.map(([, member]) => plainRef(member)) }
        : membersOnly
          ? {
              id: channelId,
              add: roster.filter(([key]) => !current.has(key)).map(([, member]) => plainRef(member)),
              remove: [...current].filter(([key]) => !selected(key)).map(([, member]) => plainRef(member)),
            }
          : { id: channelId, name, topic }
      const saved = await client.call<ChannelView>({ type: 'channel-save', channel })
      select({ kind: 'channel', channelId: saved.id })
      onClose()
    } catch (problem) {
      setError((problem as Error).message)
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={membersOnly ? `Members of #${existing?.name ?? ''}` : existing ? `#${existing.name}` : 'New channel'}
      description={membersOnly ? undefined : 'Mention a member to ask it to reply, or use @all to ask everyone.'}
      busy={busy}
      onClose={onClose}
      footer={
        <Footer
          busy={busy}
          onClose={onClose}
          action={membersOnly ? 'Save members' : existing ? 'Save' : 'Create channel'}
          form="channel-form"
          danger={
            existing &&
            !membersOnly && (
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
        {!membersOnly && (
          <>
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
          </>
        )}
        {(!existing || membersOnly) && (
          <fieldset className="field">
            <legend className="label">
              Members ({roster.length}/{chatLimits.members})
            </legend>
            <input
              type="search"
              aria-label="Search sessions"
              placeholder="Search by session, handle, or machine"
              autoFocus={membersOnly}
              value={search}
              onChange={event => setSearch(event.target.value)}
            />
            <div className="member-picker">
              {[true, false].map(inChannel => {
                const rows = options.filter(row => current.has(row.key) === inChannel)
                if (!rows.length) return null
                return (
                  <div key={String(inChannel)}>
                    <h4>{inChannel ? 'In this channel' : 'Available sessions'}</h4>
                    {rows.map(({ key, member, session, detail }) => (
                      <label key={key} className="member-option">
                        <input
                          type="checkbox"
                          checked={selected(key)}
                          disabled={!selected(key) && roster.length >= chatLimits.members}
                          onChange={event => setChanges(new Map(changes).set(key, event.target.checked))}
                        />
                        <Avatar id={member.sessionId} name={member.name} tool={session?.tool ?? null} size={26} />
                        <span>
                          <strong>{session?.name ?? member.name}</strong>
                          <small>{detail}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                )
              })}
              {!options.length && <p className="muted">{query ? 'No matching sessions.' : 'No sessions available.'}</p>}
            </div>
          </fieldset>
        )}
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

export function StopChatDialog({ target: selected, onClose }: { target: SessionRef; onClose: () => void }) {
  const { client } = useChat()
  const target = plainRef(selected)
  const session = client.session(target)
  if (!session) return null
  return <StopConfirm session={session} onClose={onClose} onConfirm={() => client.call({ type: 'stop', ...target })} />
}

export function DeleteChatDialog({ target: selected, onClose }: { target: SessionRef; onClose: () => void }) {
  const { client, select } = useChat()
  const target = plainRef(selected)
  const session = client.session(target)
  if (!session) return null
  return (
    <DeleteConfirm
      session={session}
      onClose={onClose}
      onConfirm={async () => {
        await client.call({ type: 'session-delete', ...target })
        select(null)
      }}
    />
  )
}

export function ForkChatDialog({ target: selected, onClose }: { target: SessionRef; onClose: () => void }) {
  const { client, select } = useChat()
  const target = plainRef(selected)
  const session = client.session(target)
  if (!session) return null
  return (
    <ForkDialog
      session={session}
      machine={session.target}
      onClose={onClose}
      onSave={async input => {
        const created = await client.call<SessionRef>({ type: 'session-fork', ...target, input })
        select({ kind: 'session', ...created })
        onClose()
      }}
    />
  )
}

/** Find a conversation on any machine; one Outpost has opens here, others link as new sessions. */
export function FindChatDialog({ query, onClose }: { query: string; onClose: () => void }) {
  const { client, select, open } = useChat()
  return (
    <FinderDialog
      machines={client.targets}
      initialQuery={query}
      search={(targetId, search) => client.call<ConversationResults>({ type: 'conversation-search', targetId, search })}
      onOpen={(targetId, sessionId) => {
        onClose()
        select({ kind: 'session', targetId, sessionId })
      }}
      onLink={(targetId, match) => open({ kind: 'session', targetId, conversation: match })}
      onClose={onClose}
    />
  )
}

export function MachineLink({ targetId, children }: { targetId?: string; children: React.ReactNode }) {
  const href = targetId
    ? `${pagePaths.workspace}?target=${encodeURIComponent(targetId)}`
    : `${pagePaths.workspace}?add=1`
  return <a href={href}>{children}</a>
}
