import { useEffect, useRef, useState } from 'react'
import {
  CalendarClock,
  Hash,
  LoaderCircle,
  MessagesSquare,
  Plus,
  Search,
  SquareTerminal,
  TriangleAlert,
  X,
} from 'lucide-react'
import { describeCron } from '../../shared/cron'
import { sessionKey, type ChannelView, type ChatSession } from '../../shared/chatApi'
import { pagePaths } from '../../shared/pages'
import { Avatar } from './Avatar'
import { useChat, type Selection } from './context'
import { needsYou, presence, presenceLabel } from './format'

const working = (session: ChatSession) => presence(session) === 'working'
const unread = (channel: ChannelView) => Boolean(channel.lastAt && (!channel.readAt || channel.lastAt > channel.readAt))

function SessionRow({ session, active }: { session: ChatSession; active: boolean }) {
  const { select } = useChat()
  const state = presence(session)
  const detail =
    state === 'idle' || state === 'stopped'
      ? session.rootDir.split('/').filter(Boolean).at(-1) || session.rootDir
      : presenceLabel[state]
  return (
    <button
      className={`chat-row ${active ? 'active' : ''} ${needsYou(session) ? 'attention' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={() => select({ kind: 'session', targetId: session.targetId, sessionId: session.id })}
    >
      <Avatar id={session.id} name={session.name} tool={session.tool} session={session} size={26} />
      <span className="chat-row-text">
        <strong>{session.name}</strong>
        <small className={state}>
          {state === 'terminal' && <SquareTerminal size={11} />}
          {detail}
        </small>
      </span>
      {state === 'finished' && <i className="unread-dot" aria-label="New reply" />}
    </button>
  )
}

function ChannelRow({ channel, active }: { channel: ChannelView; active: boolean }) {
  const { client, select } = useChat()
  const busy = [...client.deliveries.values()].some(
    delivery =>
      delivery.source.kind === 'channel' &&
      delivery.source.channelId === channel.id &&
      ['pending', 'sent', 'running'].includes(delivery.state),
  )
  const isUnread = unread(channel) && !active
  return (
    <button
      className={`chat-row channel-row ${active ? 'active' : ''} ${isUnread ? 'unread' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={() => select({ kind: 'channel', channelId: channel.id })}
    >
      <Hash size={15} className="channel-hash" />
      <span className="chat-row-text">
        <strong>{channel.name}</strong>
      </span>
      {busy ? (
        <LoaderCircle size={13} className="spin" aria-label="Working" />
      ) : (
        isUnread && <i className="unread-dot" aria-label="Unread" />
      )}
    </button>
  )
}

export default function Sidebar({ selection }: { selection: Selection }) {
  const { client, open } = useChat()
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        search.current?.focus()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  const filter = query.trim().toLowerCase()
  const matches = (text: string) => !filter || text.toLowerCase().includes(filter)
  const sessions = client.sessions.filter(session =>
    matches(`${session.name} ${session.handle} ${session.target} ${session.rootDir}`),
  )
  const channels = [...client.channels.values()]
    .filter(channel => matches(channel.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  const attention = sessions.filter(needsYou)
  const activeKey = selection?.kind === 'session' ? sessionKey(selection) : null
  const byTarget = client.targets
    .map(target => ({
      target,
      sessions: sessions
        .filter(session => session.targetId === target.id)
        .sort(
          (a, b) =>
            Number(working(b)) - Number(working(a)) ||
            (b.lastConnectedAt ?? '').localeCompare(a.lastConnectedAt ?? '') ||
            a.name.localeCompare(b.name),
        ),
    }))
    .filter(group => group.sessions.length || !filter)
  const schedules = [...client.schedules.values()]
  return (
    <aside className="chat-sidebar">
      <div className="chat-brand">
        <a href={pagePaths.chat} className="brand-link">
          <img src="/outpost.svg" width="24" height="24" alt="" />
          <span>Outpost</span>
        </a>
        <nav className="mode-switch" aria-label="Mode">
          <a href={pagePaths.chat} aria-current="page">
            <MessagesSquare size={14} /> Chat
          </a>
          <a
            href={pagePaths.workspace}
            onClick={() => {
              try {
                localStorage.setItem('outpost:mode', 'terminal')
              } catch {
                /* Storage is optional. */
              }
            }}
          >
            <SquareTerminal size={14} /> Terminal
          </a>
        </nav>
      </div>
      <label className="chat-search">
        <Search size={14} aria-hidden="true" />
        <input
          ref={search}
          value={query}
          placeholder="Search"
          aria-label="Search sessions and channels"
          onChange={event => setQuery(event.target.value)}
        />
        {query ? (
          <button className="icon-button" aria-label="Clear search" onClick={() => setQuery('')}>
            <X size={13} />
          </button>
        ) : (
          <kbd>{navigator.platform.startsWith('Mac') ? '⌘K' : 'Ctrl K'}</kbd>
        )}
      </label>
      <div className="chat-lists">
        {client.status === 'closed' && (
          <p className="connection-note">
            <TriangleAlert size={13} /> {client.closedMessage ?? 'Reconnecting…'}
          </p>
        )}
        {attention.length > 0 && !filter && (
          <section>
            <h2 className="chat-heading">Needs you</h2>
            {attention.map(session => (
              <SessionRow
                key={`n:${sessionKey({ targetId: session.targetId, sessionId: session.id })}`}
                session={session}
                active={false}
              />
            ))}
          </section>
        )}
        <section>
          <h2 className="chat-heading">
            Channels
            <button
              className="icon-button"
              aria-label="New channel"
              title="New channel"
              onClick={() => open({ kind: 'channel', channelId: null })}
            >
              <Plus size={15} />
            </button>
          </h2>
          {channels.map(channel => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              active={selection?.kind === 'channel' && selection.channelId === channel.id}
            />
          ))}
          {!channels.length && !filter && (
            <button className="chat-row hint-row" onClick={() => open({ kind: 'channel', channelId: null })}>
              <Plus size={15} /> Start a channel
            </button>
          )}
        </section>
        <section>
          <h2 className="chat-heading">
            Sessions
            <button
              className="icon-button"
              aria-label="New session"
              title="New session"
              onClick={() => open({ kind: 'session' })}
            >
              <Plus size={15} />
            </button>
          </h2>
          {!client.sessionsLoaded && <LoaderCircle className="spin muted" size={16} />}
          {byTarget.map(({ target, sessions: list }) => (
            <div key={target.id} className="target-group">
              {client.targets.length > 1 && (
                <h3 className="target-heading" title={target.error ?? undefined}>
                  {target.name}
                  {target.error && <TriangleAlert size={12} />}
                </h3>
              )}
              {list.map(session => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={activeKey === sessionKey({ targetId: session.targetId, sessionId: session.id })}
                />
              ))}
              {!list.length && !filter && <p className="hint-row muted">No sessions on {target.name}.</p>}
            </div>
          ))}
          {client.sessionsLoaded && !client.targets.length && (
            <p className="hint-row muted">
              Add a machine in <a href={pagePaths.workspace}>Terminal</a> mode first.
            </p>
          )}
        </section>
        {(schedules.length > 0 || !filter) && (
          <section>
            <h2 className="chat-heading">
              Schedules
              <button
                className="icon-button"
                aria-label="New schedule"
                title="New schedule"
                disabled={!client.sessions.length}
                onClick={() => open({ kind: 'schedule', scheduleId: null, session: null })}
              >
                <Plus size={15} />
              </button>
            </h2>
            {schedules.map(schedule => {
              const target = client.session(schedule)
              return (
                <button
                  key={schedule.id}
                  className={`chat-row schedule-row ${schedule.enabled ? '' : 'disabled'}`}
                  onClick={() => open({ kind: 'schedule', scheduleId: schedule.id, session: null })}
                >
                  <CalendarClock size={15} />
                  <span className="chat-row-text">
                    <strong>{schedule.name}</strong>
                    <small>
                      {schedule.enabled ? describeCron(schedule.cron) : 'Paused'}
                      {target ? ` · ${target.name}` : ''}
                    </small>
                  </span>
                  {schedule.lastRun && !schedule.lastRun.ok && (
                    <TriangleAlert size={13} className="error" aria-label="Last run failed" />
                  )}
                </button>
              )
            })}
          </section>
        )}
      </div>
      <button className="chat-new" disabled={!client.targets.length} onClick={() => open({ kind: 'session' })}>
        <Plus size={15} /> New session
      </button>
    </aside>
  )
}
