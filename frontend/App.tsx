import { useEffect, useReducer, useState } from 'react'
import { Circle, LoaderCircle, Monitor, Network, Plus, Server, Terminal } from 'lucide-react'
import type { Target, TargetInput } from '../shared/session-manager'
import { api } from './api'
import TargetForm from './TargetForm'
import TargetWorkspace from './TargetWorkspace'
import TargetNavigationItem from './TargetNavigationItem'
import { Modal } from './ui'

function updateTargetUrl(id: string) {
  const url = new URL(window.location.href)
  if (id) url.searchParams.set('target', id)
  else url.searchParams.delete('target')
  window.history.replaceState(null, '', url)
}

interface Workspace {
  targets: Target[]
  selectedId: string
  visit: number
  dialog: { kind: 'add'; id: number } | { kind: 'remove'; target: Target } | null
  nextDraft: number
}
type WorkspaceAction =
  | { type: 'loaded'; targets: Target[]; requestedId: string | null }
  | { type: 'select'; id: string }
  | { type: 'open-add' | 'close-dialog' }
  | { type: 'open-remove'; target: Target }
  | { type: 'added'; target: Target; draft: number; visit: number }
  | { type: 'updated'; target: Target }
  | { type: 'removed'; id: string }

// Keep navigation and drafts together so late mutations cannot undo newer user actions.
function workspaceReducer(state: Workspace, action: WorkspaceAction): Workspace {
  switch (action.type) {
    case 'loaded': return {
      ...state, targets: action.targets,
      selectedId: action.targets.find(target => target.id === action.requestedId)?.id ?? action.targets[0]?.id ?? '',
    }
    case 'select': return { ...state, selectedId: action.id, visit: state.visit + 1 }
    case 'open-add': return { ...state, dialog: { kind: 'add', id: state.nextDraft }, nextDraft: state.nextDraft + 1 }
    case 'open-remove': return { ...state, dialog: { kind: 'remove', target: action.target } }
    case 'close-dialog': return { ...state, dialog: null }
    case 'added': {
      const currentDraft = state.dialog?.kind === 'add' && state.dialog.id === action.draft
      const select = currentDraft && state.visit === action.visit
      return {
        ...state, targets: [...state.targets, action.target],
        dialog: currentDraft ? null : state.dialog,
        selectedId: select ? action.target.id : state.selectedId,
        visit: select ? state.visit + 1 : state.visit,
      }
    }
    case 'updated': return { ...state, targets: state.targets.map(target => target.id === action.target.id ? action.target : target) }
    case 'removed': {
      const targets = state.targets.filter(target => target.id !== action.id)
      const selected = state.selectedId === action.id
      return {
        ...state, targets, selectedId: selected ? targets[0]?.id ?? '' : state.selectedId,
        visit: selected ? state.visit + 1 : state.visit,
        dialog: state.dialog?.kind === 'remove' && state.dialog.target.id === action.id ? null : state.dialog,
      }
    }
  }
}

export default function App() {
  const [workspace, dispatch] = useReducer(workspaceReducer, {
    targets: [], selectedId: '', visit: 0, dialog: null, nextDraft: 0,
  })
  const { targets, selectedId, visit: targetVisit, dialog } = workspace
  const [loading, setLoading] = useState(true),
    [error, setError] = useState('')
  const [removing, setRemoving] = useState(false),
    [removalError, setRemovalError] = useState('')
  const selected = targets.find((target) => target.id === selectedId)
  useEffect(() => {
    const controller = new AbortController()
    api<Target[]>('/targets', 'GET', undefined, controller.signal)
      .then((items) => {
        const requestedId = new URL(window.location.href).searchParams.get(
          'target',
        )
        dispatch({ type: 'loaded', targets: items, requestedId })
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (!loading) updateTargetUrl(selectedId)
  }, [loading, selectedId])
  function select(id: string) {
    dispatch({ type: 'select', id })
    setError('')
  }
  async function addTarget(input: TargetInput, draft: number) {
    const visit = workspace.visit
    const target = await api<Target>('/targets', 'POST', input)
    dispatch({ type: 'added', target, draft, visit })
    setError('')
  }
  async function removeTarget(target: Target) {
    setRemoving(true)
    setRemovalError('')
    try {
      await api(`/targets/${target.id}`, 'DELETE')
      dispatch({ type: 'removed', id: target.id })
    } catch (error) {
      setRemovalError((error as Error).message)
    } finally {
      setRemoving(false)
    }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <img className="brand-mark" src="/outpost.svg" width="42" height="42" alt="" />
          <span>
            Outpost<span className="brand-sub">AI Session Manager</span>
          </span>
        </a>
        <div className="workspace-label">
          <Circle className="status-indicator" size={6} fill="currentColor" strokeWidth={0} aria-hidden="true" /> LOCAL WORKSPACE{' '}
          <span className="version">v0.1</span>
        </div>
        <div className="sidebar-section">
          <span>TARGETS</span>
          <button
            className="icon-button"
            title="Add target"
            aria-label="Add target"
            disabled={loading}
            onClick={() => dispatch({ type: 'open-add' })}
          >
            <Plus size={16} />
          </button>
        </div>
        <nav aria-label="Targets">
          {targets.map((target) => (
            <TargetNavigationItem
              key={target.id}
              target={target}
              selected={target.id === selectedId}
              onSelect={() => select(target.id)}
              onRemove={() => { setRemovalError(''); dispatch({ type: 'open-remove', target }) }}
            />
          ))}
        </nav>
        {!targets.length && (
          <p className="sidebar-empty">
            Your dev machines,
            <br />
            one place to return to.
          </p>
        )}
        <button className="add-target" disabled={loading} onClick={() => dispatch({ type: 'open-add' })}>
          <Plus size={16} /> Add target
        </button>
        <div className="sidebar-bottom">
          <span className="tiny-terminal">
            <Terminal />
          </span>
          <strong>Pick up where you left off.</strong>
          <p>
            Your terminal can close.
            <br />
            Your work keeps going.
          </p>
          <div>
            <Circle className="status-indicator green" size={6} fill="currentColor" strokeWidth={0} aria-hidden="true" /> Local & agentless SSH
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            {selected?.kind === 'local' ? <Monitor size={16} aria-hidden="true" /> : <Server size={16} aria-hidden="true" />}
            <span>Targets</span>
            <span className="slash">/</span>
            <strong>{selected?.name ?? 'Overview'}</strong>
          </div>
          <span className="local-badge">
            <Circle className="status-indicator green" size={6} fill="currentColor" strokeWidth={0} aria-hidden="true" /> Local manager
          </span>
        </header>
        <main>
          {loading ? (
            <div className="empty-state">
              <LoaderCircle className="loading-spinner" size={22} />
              <p>Loading your workspace…</p>
            </div>
          ) : !selected ? (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">YOUR WORKSPACE</span>
                  <h1>Keep your sessions close.</h1>
                  <p>
                    Persistent Codex, Kimi, and Claude sessions. Wherever your
                    dev machine lives.
                  </p>
                </div>
              </div>
              {error && (
                <div className="error-banner" role="alert">
                  {error}
                </div>
              )}
              <section className="welcome-card">
                <div className="welcome-visual" aria-hidden="true">
                  <Network size={72} strokeWidth={1.5} />
                </div>
                <span className="eyebrow">A TERMINAL YOU CAN COME BACK TO</span>
                <h2>Your next session starts here.</h2>
                <p>
                  Add this computer or an SSH target,
                  <br />
                  choose a coding tool, and name your session.
                </p>
                <button
                  className="button primary"
                  onClick={() => dispatch({ type: 'open-add' })}
                >
                  <Plus /> Add your first target
                </button>
                <span className="welcome-footnote">
                  Local or SSH · No custom agent · Your own terminal
                </span>
              </section>
              <div className="steps">
                {[
                  [
                    '01',
                    'Connect a machine',
                    'Use this computer or SSH to your dev server.',
                  ],
                  [
                    '02',
                    'Make room for your work',
                    'Create a named session in any project directory.',
                  ],
                  [
                    '03',
                    'Leave. Come back. Continue.',
                    'Close your terminal while your coding tool keeps running.',
                  ],
                ].map(([number, title, description]) => (
                  <div key={number}>
                    <span>{number}</span>
                    <h3>{title}</h3>
                    <p>{description}</p>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <TargetWorkspace
              key={`${selected.id}:${targetVisit}`}
              target={selected}
              externalDialogOpen={dialog !== null}
              onUpdate={(target) => dispatch({ type: 'updated', target })}
            />
          )}
        </main>
        <footer className="page-footer">
          <span>OUTPOST</span>
          <span>Built for the way you work.</span>
        </footer>
      </div>
      {dialog?.kind === 'add' && (
        <TargetForm key={dialog.id} onSave={input => addTarget(input, dialog.id)} onClose={() => dispatch({ type: 'close-dialog' })} />
      )}
      {dialog?.kind === 'remove' && (
        <Modal title={`Remove ${dialog.target.name}?`}
          subtitle="This only removes the connection from this manager. Sessions and running coding tools stay on the target."
          closeDisabled={removing} onClose={() => dispatch({ type: 'close-dialog' })}
        >
          {removalError && <p className="error" role="alert">{removalError}</p>}
          <div className="modal-actions">
            <button className="button secondary" disabled={removing} onClick={() => dispatch({ type: 'close-dialog' })}>Cancel</button>
            <button className="button danger" disabled={removing} onClick={() => void removeTarget(dialog.target)}>
              {removing ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
