import { useEffect, useReducer, useState } from 'react'
import { LoaderCircle, Monitor, Plus, Server } from 'lucide-react'
import type { ConversationResults, ConversationSearch, Target, TargetInput } from '../shared/model'
import { pagePaths } from '../shared/pages'
import { api } from './api'
import { useAuth } from './auth/useAuth'
import { OnboardingBanner } from './onboarding/OnboardingBanner'
import { replaceUrl } from './router'
import { SidebarBody } from './ui/AppSidebar'
import { Link } from './ui/Link'
import { getCachedTargets, setCachedTargets } from './workspace/cache'
import FinderDialog from './workspace/FinderDialog'
import { address } from './workspace/labels'
import TargetDialog from './workspace/TargetDialog'
import TargetView, { type TargetRequest } from './workspace/TargetView'

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

function pickSelected(targets: Target[], current: string): string {
  const requested = new URLSearchParams(window.location.search).get('target')
  if (requested && targets.some(target => target.id === requested)) return requested
  if (current && targets.some(target => target.id === current)) return current
  return targets[0]?.id ?? ''
}

// Navigation and machine changes live together so late responses cannot undo newer choices.
function reducer(state: Workspace, action: Action): Workspace {
  const targets = state.targets ?? []
  switch (action.type) {
    case 'loaded':
      return {
        ...state,
        targets: action.targets,
        selected: pickSelected(action.targets, state.selected),
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

function initialWorkspace(accountKey: string): Workspace {
  const cached = getCachedTargets(accountKey)
  return {
    targets: cached,
    selected: cached ? pickSelected(cached, '') : '',
    visit: 0,
    request: null,
  }
}

const searchMachine = (id: string, input: ConversationSearch, signal: AbortSignal) =>
  api<ConversationResults>(`/targets/${id}/conversations/search`, 'POST', input, signal)

export default function App() {
  const { user } = useAuth()
  const accountKey = user?.id ?? 'local'
  const [{ targets, selected, visit, request }, dispatch] = useReducer(reducer, accountKey, initialWorkspace)
  const [error, setError] = useState('')
  // Chat links here with ?add=1 to add a machine.
  const [adding, setAdding] = useState(() => new URLSearchParams(window.location.search).has('add'))
  const [finding, setFinding] = useState(false)
  const target = targets?.find(item => item.id === selected)

  useEffect(() => {
    document.title = 'Outpost'
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    api<Target[]>('/targets', 'GET', undefined, controller.signal).then(
      items => {
        setCachedTargets(accountKey, items)
        dispatch({ type: 'loaded', targets: items })
      },
      problem => {
        if (!controller.signal.aborted) setError(problem.message)
      },
    )
    return () => controller.abort()
  }, [accountKey])

  useEffect(() => {
    if (!targets) return
    setCachedTargets(accountKey, targets)
  }, [accountKey, targets])

  useEffect(() => {
    if (!targets) return
    const url = new URL(window.location.href)
    url.searchParams.delete('add')
    if (selected) url.searchParams.set('target', selected)
    else url.searchParams.delete('target')
    replaceUrl(`${url.pathname}${url.search}${url.hash}`)
  }, [targets, selected])

  return (
    <>
      <SidebarBody>
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
            const Icon = item.kind === 'local' ? Monitor : Server
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
      </SidebarBody>
      <main className="content">
        <OnboardingBanner hasMachines={Boolean(targets?.length)} />
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
              Add the Linux machine where you work, then choose a project and a coding tool. Your sessions keep running
              on that machine when you disconnect.
            </p>
            <div className="onboarding-inline-cta">
              <button className="button primary" onClick={() => setAdding(true)}>
                <Plus size={15} />
                Add a machine
              </button>
              <Link className="button" href={pagePaths.onboarding}>
                Getting started guide
              </Link>
            </div>
            <ol className="steps">
              <li>
                <strong>Add a machine</strong>
                <span>Choose how Outpost connects to the Linux machine that runs your sessions.</span>
              </li>
              <li>
                <strong>Create a session</strong>
                <span>Pick a coding tool and a project directory.</span>
              </li>
              <li>
                <strong>Connect to your session</strong>
                <span>Open the terminal in your browser or Outpost Desktop.</span>
              </li>
            </ol>
          </section>
        )}
      </main>
      {adding && (
        <TargetDialog
          onClose={() => setAdding(false)}
          onSave={async input => {
            const target = await api<Target>('/targets', 'POST', input as TargetInput)
            dispatch({ type: 'added', target })
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
    </>
  )
}
