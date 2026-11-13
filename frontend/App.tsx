import { useEffect, useReducer, useState } from 'react'
import { LoaderCircle, Monitor, Plus, Server } from 'lucide-react'
import type { ConversationResults, ConversationSearch, Target, TargetInput } from '../shared/model'
import { api } from './api'
import { useAuth } from './auth/useAuth'
import { rememberMode } from './mode'
import { AppSidebar } from './ui/AppSidebar'
import FinderDialog from './workspace/FinderDialog'
import TargetDialog from './workspace/TargetDialog'
import TargetView, { type TargetRequest } from './workspace/TargetView'
import { address } from './workspace/labels'

interface Workspace {
  targets: Target[] | null
  selected: string
  visit: number
  /** What the newly shown machine should do first, e.g. open a found conversation. */
  request: TargetRequest | null
}
type Action =
  | { type: 'loaded'; targets: Target[] }
  | { type: 'select'; id: string; request?: TargetRequest }
  | { type: 'added' | 'updated'; target: Target }
  | { type: 'removed'; id: string }

// Navigation and machine changes live together so late responses cannot undo newer choices.
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
      return { ...state, selected: action.id, visit: state.visit + 1, request: action.request ?? null }
    case 'added':
      return { targets: [...targets, action.target], selected: action.target.id, visit: state.visit + 1, request: null }
    case 'updated':
      return { ...state, targets: targets.map(target => (target.id === action.target.id ? action.target : target)) }
    case 'removed': {
      const remaining = targets.filter(target => target.id !== action.id)
      return {
        targets: remaining,
        selected: state.selected === action.id ? (remaining[0]?.id ?? '') : state.selected,
        visit: state.visit + 1,
        request: null,
      }
    }
  }
}

const searchMachine = (id: string, input: ConversationSearch, signal: AbortSignal) =>
  api<ConversationResults>(`/targets/${id}/conversations/search`, 'POST', input, signal)

export default function App() {
  const { mode } = useAuth()
  const [{ targets, selected, visit, request }, dispatch] = useReducer(reducer, {
    targets: null,
    selected: '',
    visit: 0,
    request: null,
  })
  const [error, setError] = useState('')
  // Chat links here with ?add=1 to add a machine.
  const [adding, setAdding] = useState(() => new URLSearchParams(window.location.search).has('add'))
  const [finding, setFinding] = useState(false)
  const target = targets?.find(item => item.id === selected)

  useEffect(() => rememberMode('machines'), [])
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
    url.searchParams.delete('add')
    if (selected) url.searchParams.set('target', selected)
    else url.searchParams.delete('target')
    window.history.replaceState(null, '', url)
  }, [targets, selected])

  return (
    <div className="app">
      <AppSidebar mode="machines">
        <div className="sidebar-heading">
          <span>Machines</span>
          <button
            className="icon-button"
            aria-label="Add a machine"
            title="Add a machine"
            disabled={!targets}
            onClick={() => setAdding(true)}
          >
            <Plus size={16} />
          </button>
        </div>
        <nav aria-label="Machines">
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
      </AppSidebar>
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
            request={request}
            onFind={() => setFinding(true)}
            onUpdated={updated => dispatch({ type: 'updated', target: updated })}
            onRemoved={removed => dispatch({ type: 'removed', id: removed.id })}
          />
        ) : (
          <section className="welcome">
            <img src="/outpost.svg" width="48" height="48" alt="" />
            <h1>Run your coding agents on your own machines</h1>
            <p>
              Outpost keeps Claude Code, Codex, Kimi Code and DeepSeek Harness running in sessions on your Linux
              machines. Work with a session in a terminal from your browser, Outpost Desktop or your phone, or chat with
              it and bring several into a channel. Sessions keep running when you close the page.
            </p>
            <button className="button primary" onClick={() => setAdding(true)}>
              <Plus size={15} />
              Add a machine
            </button>
            <ol className="steps">
              <li>
                <strong>Add a machine</strong>
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
                <strong>Work in a terminal or in chat</strong>
                <span>Connect a terminal from anywhere, or message the session in Chat.</span>
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
      {finding && targets && (
        <FinderDialog
          machines={targets}
          initialMachine={selected}
          search={searchMachine}
          onOpen={(machineId, sessionId) => {
            setFinding(false)
            dispatch({ type: 'select', id: machineId, request: { kind: 'open', sessionId } })
          }}
          onLink={(machineId, match) => {
            setFinding(false)
            dispatch({ type: 'select', id: machineId, request: { kind: 'link', match } })
          }}
          onClose={() => setFinding(false)}
        />
      )}
    </div>
  )
}
