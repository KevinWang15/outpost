import { useState } from 'react'
import { ArrowRight, Circle, Ellipsis, ImagePlus, LoaderCircle, Plus, RefreshCw, Search, Square, SquareTerminal, Trash2 } from 'lucide-react'
import type { Session } from '../shared/session-manager'
import { codingToolLabels } from '../shared/session-manager'
import type { ConnectionMode, PendingConnection } from './useSessionConnection'
import SessionActivityBadge from './SessionActivityBadge'

const statusLabel: Record<Session['status'], string> = {
  idle: 'Ready',
  attached: 'Attached',
  detached: 'Detached',
  stopped: 'Stopped',
}
function relativeDate(value: string) {
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
  return new Date(value).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  })
}
export default function SessionList({
  sessions, error, refreshing, canCreate, connecting,
  checking, onCheck, onRefresh, onCreate, onConnect, onImage, onConfirm,
}: {
  sessions: Session[]
  error: string
  refreshing: boolean
  canCreate: boolean
  connecting: PendingConnection | null
  checking: string[]
  onCheck: (session: Session) => void
  onRefresh: () => void
  onCreate: () => void
  onConnect: (session: Session, mode: ConnectionMode) => void
  onImage: (session: Session) => void
  onConfirm: (session: Session, action: 'delete' | 'terminate') => void
}) {
  const [search, setSearch] = useState('')
  const filtered = sessions.filter(session =>
    `${session.name} ${session.rootDir} ${session.backend} ${codingToolLabels[session.tool]} ${session.cliSessionId}`
      .toLowerCase().includes(search.toLowerCase()),
  )
  return (
    <section className="sessions-panel">
      <div className="panel-toolbar">
        <div>
          <h2>Sessions</h2>
          <span className="count">{sessions.length}</span>
        </div>
        <div>
          <div className="session-search">
            <Search size={16} aria-hidden="true" />
            <input
              className="search"
              aria-label="Search sessions"
              placeholder="Filter sessions…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <button
            className={`icon-button ${refreshing ? 'spinning' : ''}`}
            aria-label="Refresh sessions"
            disabled={refreshing}
            onClick={() => onRefresh()}
          >
            <RefreshCw />
          </button>
        </div>
      </div>
      {refreshing && !sessions.length ? (
        <div className="empty-sessions" role="status">
          <LoaderCircle className="loading-spinner" size={22} />
          <p>Fetching sessions from the target…</p>
        </div>
      ) : error && !sessions.length ? (
        <div className="empty-sessions">
          <p className="error" role="alert">
            {error}
          </p>
          <button className="button secondary" onClick={() => onRefresh()}>
            Retry fetching sessions
          </button>
        </div>
      ) : sessions.length ? (
        <div className="session-table">
          <div className="table-head">
            <span>SESSION / DIRECTORY</span>
            <span>ACTIVITY / TERMINAL</span>
            <span>LAST CONNECTED</span>
            <span />
          </div>
          {filtered.map((session) => (
            <div className="session-row" key={session.id}>
              <div className="session-identity">
                <SquareTerminal className="session-icon" size={36} strokeWidth={1.5} aria-hidden="true" />
                <div>
                  <div className="session-title">
                    <strong>{session.name}</strong>
                    <span className={`tag session-backend-badge ${session.backend}`} aria-label={`Session backend: ${session.backend}`}>{session.backend}</span>
                  </div>
                  <code title={session.rootDir}>{session.rootDir}</code>
                  <small title={session.cliSessionId}>{codingToolLabels[session.tool]} · CLI session {session.cliSessionId}</small>
                </div>
              </div>
              <div className="session-state">
              <SessionActivityBadge session={session} checking={checking.includes(session.id)} onCheck={onCheck} />
              <span className={`status ${session.status}`}>
                <Circle className="status-indicator" size={6} fill="currentColor" strokeWidth={0} aria-hidden="true" />
                {statusLabel[session.status]}
              </span>
              </div>
              <span className="last-connected">
                {session.lastConnectedAt
                  ? relativeDate(session.lastConnectedAt)
                  : 'Not connected yet'}
              </span>
              <div className="row-actions">
                <button
                  className="icon-button"
                  title={`Attach an image to ${session.name}`}
                  aria-label={`Attach an image to ${session.name}`}
                  onClick={() => onImage(session)}
                >
                  <ImagePlus size={16} />
                </button>
                <div className="connect-button" role="group" aria-label={`Connect to ${session.name}`}>
                  <button
                    className="button connect"
                    title="Open your preferred available terminal on the computer running Outpost"
                    disabled={connecting?.sessionId === session.id}
                    onClick={() => onConnect(session, 'launch')}
                  >
                    {connecting?.sessionId === session.id
                      ? connecting.mode === 'launch' ? 'Opening…' : 'Preparing…'
                      : 'Connect'}
                    {connecting?.sessionId === session.id
                      ? <LoaderCircle size={15} className="loading-spinner" aria-hidden="true" />
                      : <ArrowRight size={15} aria-hidden="true" />}
                  </button>
                  <button
                    className="button connect connect-options"
                    title="Connection options"
                    aria-label={`Connection options for ${session.name}`}
                    aria-haspopup="dialog"
                    disabled={connecting?.sessionId === session.id}
                    onClick={() => onConnect(session, 'options')}
                  >
                    <Ellipsis size={17} aria-hidden="true" />
                  </button>
                </div>
                {['attached', 'detached'].includes(session.status) ? (
                  <button className="icon-button terminate-button" title={`Terminate ${session.name}`}
                    aria-label={`Terminate ${session.name}`} onClick={() => onConfirm(session, 'terminate')}>
                    <Square size={16} />
                  </button>
                ) : (
                  <button className="icon-button delete-button" aria-label={`Delete ${session.name}`}
                    onClick={() => onConfirm(session, 'delete')}>
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </div>
          ))}
          {!filtered.length && (
            <p className="no-matches">No sessions match “{search}”.</p>
          )}
        </div>
      ) : (
        <div className="empty-sessions">
          <SquareTerminal className="session-icon" size={48} strokeWidth={1.5} aria-hidden="true" />
          <h3>A fresh workspace.</h3>
          <p>Create your first session to start working on this target.</p>
          <button
            className="button secondary"
            disabled={!canCreate}
            onClick={() => onCreate()}
          >
            <Plus size={16} /> Create session
          </button>
        </div>
      )}
      <div className="panel-footer">
        <Circle className="status-indicator green" size={6} fill="currentColor" strokeWidth={0} aria-hidden="true" /> Sessions survive terminal
        disconnections
        <span>Refreshes every 10 seconds</span>
      </div>
    </section>
  )
}
