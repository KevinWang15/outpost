import { useState } from 'react'
import {
  GitFork,
  History,
  LoaderCircle,
  MessagesSquare,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Square,
  SquareTerminal,
  Trash2,
} from 'lucide-react'
import { pagePaths } from '../../shared/pages'
import type { Session } from '../../shared/model'
import { harnessLabel, supportsTerminal } from '../../shared/harnesses'
import { ToolIcon } from '../ui/ToolIcon'
import { Menu } from '../ui/Menu'
import ActivityBadge from './ActivityBadge'
import { relativeTime } from './labels'

const statusLabels: Record<Session['status'], string> = {
  ready: 'Not started',
  attached: 'Attached',
  detached: 'Running',
  stopped: 'Stopped',
}

export default function SessionTable({
  targetId,
  sessions,
  error,
  refreshing,
  canCreate,
  checking,
  onRefresh,
  onCreate,
  onConnect,
  onFork,
  onEdit,
  onConversations,
  onRestart,
  onCheck,
  onTerminate,
  onDelete,
}: {
  targetId: string
  sessions: Session[] | null
  error: string
  refreshing: boolean
  canCreate: boolean
  checking: string[]
  onRefresh: () => void
  onCreate: () => void
  onConnect: (session: Session) => void
  onFork: (session: Session) => void
  onEdit: (session: Session) => void
  onConversations: (session: Session) => void
  onRestart: (session: Session) => void
  onCheck: (session: Session) => void
  onTerminate: (session: Session) => void
  onDelete: (session: Session) => void
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
          <p>Reading sessions from the target…</p>
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
          <p>A session runs a coding tool on this target and keeps running when you disconnect.</p>
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
            <span role="columnheader">Status</span>
            <span role="columnheader">Last connected</span>
            <span role="columnheader" />
          </div>
          {visible.map(session => {
            const running = session.status === 'attached' || session.status === 'detached'
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
                <span role="cell" className={`status ${session.status}`}>
                  <i />
                  {session.driver === 'chat' ? 'In chat' : statusLabels[session.status]}
                </span>
                <span role="cell" className="muted">
                  {relativeTime(session.lastConnectedAt)}
                </span>
                <div className="row-actions" role="cell">
                  {session.driver === 'chat' || !supportsTerminal(session.tool) ? (
                    <a
                      className="button small"
                      href={`${pagePaths.chat}?${new URLSearchParams({ target: targetId, session: session.id })}`}
                    >
                      <MessagesSquare size={14} />
                      Open in chat
                    </a>
                  ) : (
                    <button className="button primary small" onClick={() => onConnect(session)}>
                      Connect
                    </button>
                  )}
                  <Menu
                    label={`More actions for ${session.name}`}
                    items={[
                      { label: 'Edit session', icon: <Pencil size={14} />, onSelect: () => onEdit(session) },
                      {
                        label: 'Conversations',
                        icon: <History size={14} />,
                        onSelect: () => onConversations(session),
                      },
                      { label: 'Fork', icon: <GitFork size={14} />, onSelect: () => onFork(session) },
                      'separator',
                      running
                        ? {
                            label: 'Terminate',
                            icon: <Square size={14} />,
                            danger: true,
                            onSelect: () => onTerminate(session),
                          }
                        : {
                            label: 'Delete',
                            icon: <Trash2 size={14} />,
                            danger: true,
                            onSelect: () => onDelete(session),
                          },
                    ]}
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
