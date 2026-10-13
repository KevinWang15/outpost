import { lazy, Suspense, useEffect, useReducer, useState } from 'react'
import { LoaderCircle, LogOut, Monitor, Plus, Server, UserRound } from 'lucide-react'
import type { Target, TargetInput } from '../shared/model'
import { api } from './api'
import AccountDialog from './auth/AccountDialog'
import { useAuth } from './auth/useAuth'
import { Menu } from './ui/Menu'
import TargetDialog from './workspace/TargetDialog'
import TargetView from './workspace/TargetView'
import { address } from './workspace/labels'

const TerminalPage = lazy(() => import('./terminal/TerminalPage'))

interface Workspace {
  targets: Target[] | null
  selected: string
  visit: number
}
type Action =
  | { type: 'loaded'; targets: Target[] }
  | { type: 'select'; id: string }
  | { type: 'added' | 'updated'; target: Target }
  | { type: 'removed'; id: string }

// Navigation and target changes live together so late responses cannot undo newer choices.
function reducer(state: Workspace, action: Action): Workspace {
  const targets = state.targets ?? []
  switch (action.type) {
    case 'loaded': {
      const requested = new URLSearchParams(window.location.search).get('target')
      return {
        ...state,
        targets: action.targets,
        selected: action.targets.find(target => target.id === requested)?.id ?? action.targets[0]?.id ?? '',
      }
    }
    case 'select':
      return { ...state, selected: action.id, visit: state.visit + 1 }
    case 'added':
      return { targets: [...targets, action.target], selected: action.target.id, visit: state.visit + 1 }
    case 'updated':
      return { ...state, targets: targets.map(target => (target.id === action.target.id ? action.target : target)) }
    case 'removed': {
      const remaining = targets.filter(target => target.id !== action.id)
      return {
        targets: remaining,
        selected: state.selected === action.id ? (remaining[0]?.id ?? '') : state.selected,
        visit: state.visit + 1,
      }
    }
  }
}

export default function App() {
  if (window.location.pathname === '/terminal')
    return (
      <Suspense
        fallback={
          <div className="auth-loading" role="status">
            Opening terminal…
          </div>
        }
      >
        <TerminalPage />
      </Suspense>
    )
  return <WorkspaceView />
}

function WorkspaceView() {
  const { mode, user, signOut } = useAuth()
  const [{ targets, selected, visit }, dispatch] = useReducer(reducer, { targets: null, selected: '', visit: 0 })
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false),
    [account, setAccount] = useState(false)
  const target = targets?.find(item => item.id === selected)

  useEffect(() => {
    const controller = new AbortController()
    api<Target[]>('/targets', 'GET', undefined, controller.signal).then(
      items => dispatch({ type: 'loaded', targets: items }),
      problem => {
        if (!controller.signal.aborted) setError(problem.message)
      },
    )
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (!targets) return
    const url = new URL(window.location.href)
    if (selected) url.searchParams.set('target', selected)
    else url.searchParams.delete('target')
    window.history.replaceState(null, '', url)
  }, [targets, selected])

  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href="/">
          <img src="/outpost.svg" width="28" height="28" alt="" />
          <span>Outpost</span>
          <span className="mode">{mode === 'hosted' ? 'Hosted' : 'Local'}</span>
        </a>
        <div className="sidebar-heading">
          <span>Targets</span>
          <button
            className="icon-button"
            aria-label="Add target"
            title="Add target"
            disabled={!targets}
            onClick={() => setAdding(true)}
          >
            <Plus size={16} />
          </button>
        </div>
        <nav aria-label="Targets">
          {targets?.map(item => {
            const Icon = item.kind === 'ssh' ? Server : Monitor
            return (
              <button
                key={item.id}
                className={`nav-item ${item.id === selected ? 'active' : ''}`}
                aria-current={item.id === selected ? 'page' : undefined}
                onClick={() => dispatch({ type: 'select', id: item.id })}
              >
                <Icon size={16} />
                <span>
                  <strong>{item.name}</strong>
                  <small>{address(item)}</small>
                </span>
              </button>
            )
          })}
        </nav>
        <div className="sidebar-footer">
          {mode === 'hosted' && user ? (
            <Menu
              label="Account"
              trigger={
                <button className="account-button" aria-label="Account">
                  <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
                  <span>
                    <strong>{user.name}</strong>
                    <small>{user.email}</small>
                  </span>
                </button>
              }
              items={[
                { label: 'Account settings', icon: <UserRound size={14} />, onSelect: () => setAccount(true) },
                {
                  label: 'Sign out',
                  icon: <LogOut size={14} />,
                  onSelect: () => void signOut().catch(problem => setError(problem.message)),
                },
              ]}
            />
          ) : (
            <p className="muted">Runs on this computer. Sessions keep running on your targets.</p>
          )}
        </div>
      </aside>
      <main className="content">
        {error && (
          <p className="banner error" role="alert">
            {error}
          </p>
        )}
        {!targets ? (
          !error && (
            <div className="empty page-empty">
              <LoaderCircle className="spin" size={20} />
            </div>
          )
        ) : target ? (
          <TargetView
            key={`${target.id}:${visit}`}
            target={target}
            onUpdated={updated => dispatch({ type: 'updated', target: updated })}
            onRemoved={removed => dispatch({ type: 'removed', id: removed.id })}
          />
        ) : (
          <section className="welcome">
            <img src="/outpost.svg" width="48" height="48" alt="" />
            <h1>Keep your AI coding sessions running</h1>
            <p>
              Add a Linux machine, start Claude Code, Codex or Kimi in a session, and connect from your browser or your
              own terminal. Sessions keep running when you disconnect.
            </p>
            <button className="button primary" onClick={() => setAdding(true)}>
              <Plus size={15} />
              Add a target
            </button>
            <ol className="steps">
              <li>
                <strong>Add a target</strong>
                <span>
                  {mode === 'hosted'
                    ? 'An SSH server that trusts your Outpost key.'
                    : 'This computer or an SSH server.'}
                </span>
              </li>
              <li>
                <strong>Create a session</strong>
                <span>Pick a coding tool and a project directory.</span>
              </li>
              <li>
                <strong>Connect anywhere</strong>
                <span>Web terminal, iTerm2 or Windows Terminal.</span>
              </li>
            </ol>
          </section>
        )}
      </main>
      {adding && (
        <TargetDialog
          onClose={() => setAdding(false)}
          onSave={async input => {
            dispatch({ type: 'added', target: await api<Target>('/targets', 'POST', input as TargetInput) })
            setAdding(false)
          }}
        />
      )}
      {account && <AccountDialog onClose={() => setAccount(false)} />}
    </div>
  )
}
