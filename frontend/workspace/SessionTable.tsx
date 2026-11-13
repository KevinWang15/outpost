import { useState } from 'react'
import { LoaderCircle, MessagesSquare, Plus, RefreshCw, Search, SquareTerminal } from 'lucide-react'
import type { Session } from '../../shared/model'
import { harnessLabel } from '../../shared/harnesses'
import { ToolIcon } from '../ui/ToolIcon'
import ActivityBadge from './ActivityBadge'
import { placeLabel, relativeTime } from './labels'
import { SessionMenu, type SessionActions } from './SessionMenu'

export default function SessionTable({
  sessions,
  error,
  refreshing,
  canCreate,
  checking,
  onRefresh,
  onCreate,
  primary,
  actionsFor,
  onRestart,
  onConversations,
  onCheck,
}: {
  sessions: Session[] | null
  error: string
  refreshing: boolean
  canCreate: boolean
  checking: string[]
  onRefresh: () => void
  onCreate: () => void
  /** The row's main action; the menu offers the other place. */
  primary: (session: Session) => { kind: 'chat'; href: string } | { kind: 'terminal'; connect: () => void }
  actionsFor: (session: Session) => SessionActions
  onRestart: (session: Session) => void
  onConversations: (session: Session) => void
  onCheck: (session: Session) => void
}) {
  const [filter, setFilter] = useState('')
  const visible = (sessions ?? []).filter(session =>
    `${session.name} ${session.rootDir} ${harnessLabel(session.tool)}`
      .toLowerCase()
      .includes(filter.trim().toLowerCase()),
  )
  return (
    <section className="card sessions">
      <header className="card-header">
        <h2>Sessions {sessions && <span className="count">{sessions.length}</span>}</h2>
        <div className="card-tools">
          {(sessions?.length ?? 0) > 4 && (
            <label className="filter">
              <Search size={14} aria-hidden="true" />
              <input
                aria-label="Filter sessions"
                placeholder="Filter"
                value={filter}
                onChange={event => setFilter(event.target.value)}
              />
            </label>
          )}
          <button
            className="icon-button"
            aria-label="Refresh sessions"
            title="Refresh"
            disabled={refreshing}
            onClick={onRefresh}
          >
            <RefreshCw size={15} className={refreshing ? 'spin' : ''} />
          </button>
        </div>
      </header>
      {sessions === null ? (
        <div className="empty">
          <LoaderCircle className="spin" size={18} />
          <p>Reading sessions from the machine…</p>
        </div>
      ) : error ? (
        <div className="empty">
          <p className="error" role="alert">
            {error}
          </p>
          <button className="button" onClick={onRefresh}>
            Try again
          </button>
        </div>
      ) : !sessions.length ? (
        <div className="empty">
          <SquareTerminal size={28} strokeWidth={1.5} />
          <h3>No sessions yet</h3>
          <p>A session runs a coding tool on this machine and keeps running when you disconnect.</p>
          <button className="button primary" disabled={!canCreate} onClick={onCreate}>
            <Plus size={15} />
            New session
          </button>
        </div>
      ) : (
        <div className="table" role="table" aria-label="Sessions">
          <div className="table-row table-head" role="row">
            <span role="columnheader">Session</span>
            <span role="columnheader">Activity</span>
            <span role="columnheader">Runs in</span>
            <span role="columnheader">Last connected</span>
            <span role="columnheader" />
          </div>
          {visible.map(session => {
            const main = primary(session)
            const pending = session.runningRevision !== null && session.runningRevision !== session.config.revision
            const moved = session.conversations.at(-1)!.movedTo
            return (
              <div className="table-row" role="row" key={session.id}>
                <div className="session-name" role="cell">
                  <div>
                    <strong>{session.name}</strong>
                    <span className="chip">
                      <ToolIcon tool={session.tool} size={11} />
                      {harnessLabel(session.tool)}
                    </span>
                  </div>
                  {session.title && session.title !== session.name && (
                    <span className="session-title" title={session.title}>
                      {session.title}
                    </span>
                  )}
                  <code title={session.rootDir}>{session.rootDir}</code>
                  {pending && (
                    <span className="session-pending">
                      Changes apply at the next start
                      <button className="button small" onClick={() => onRestart(session)}>
                        Restart now
                      </button>
                    </span>
                  )}
                  {moved && (
                    <span className="session-pending">
                      Its conversation continues in {moved.name}
                      <button className="button small" onClick={() => onConversations(session)}>
                        Choose another
                      </button>
                    </span>
                  )}
                </div>
                <span role="cell">
                  <ActivityBadge session={session} checking={checking.includes(session.id)} onCheck={onCheck} />
                </span>
                <span role="cell" className={`status ${session.driver ?? ''} ${session.status}`}>
                  <i />
                  {placeLabel(session)}
                </span>
                <span role="cell" className="muted">
                  {relativeTime(session.lastConnectedAt)}
                </span>
                <div className="row-actions" role="cell">
                  {main.kind === 'chat' ? (
                    <a className="button small" href={main.href}>
                      <MessagesSquare size={14} />
                      Open in chat
                    </a>
                  ) : (
                    <button className="button primary small" onClick={main.connect}>
                      Connect
                    </button>
                  )}
                  <SessionMenu
                    session={session}
                    label={`More actions for ${session.name}`}
                    actions={actionsFor(session)}
                  />
                </div>
              </div>
            )
          })}
          {!visible.length && <p className="empty-row">No sessions match “{filter}”.</p>}
        </div>
      )}
    </section>
  )
}
