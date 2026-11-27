import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, Link, LoaderCircle, Search } from 'lucide-react'
import type { ConversationMatch, ConversationResults, ConversationSearch } from '../../shared/model'
import { harnesses, harnessLabel, type HarnessId } from '../../shared/harnesses'
import { ToolIcon } from '../ui/ToolIcon'
import { Dialog } from '../ui/Dialog'
import { relativeTime } from './labels'

interface FinderMachine {
  id: string
  name: string
}
interface Found extends ConversationMatch {
  machine: FinderMachine
}

interface FinderResults {
  found: Found[]
  truncated: boolean
  warnings: string[]
}

async function runFinderSearch(
  term: string,
  selectedTool: HarnessId | '',
  targets: FinderMachine[],
  search: (machineId: string, input: ConversationSearch, signal: AbortSignal) => Promise<ConversationResults>,
  signal: AbortSignal,
): Promise<FinderResults> {
  const input = { query: term, ...(selectedTool ? { tool: selectedTool } : {}) }
  const settled = await Promise.allSettled(targets.map(item => search(item.id, input, signal)))
  const found: Found[] = []
  const warnings: string[] = []
  let truncated = false
  settled.forEach((outcome, index) => {
    const item = targets[index]
    const prefix = targets.length > 1 ? `${item.name}: ` : ''
    if (outcome.status === 'rejected') {
      warnings.push(`${prefix}${(outcome.reason as Error).message}`)
      return
    }
    found.push(...outcome.value.sessions.map(match => ({ ...match, machine: item })))
    warnings.push(...outcome.value.warnings.map(warning => `${prefix}${warning}`))
    truncated ||= outcome.value.truncated
  })
  found.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  return { found, truncated, warnings }
}

/** Search the coding tools' history on the user's machines, including
 * conversations started outside Outpost, and open or link what it finds. */
export default function FinderDialog({
  machines,
  initialMachine = '',
  initialQuery = '',
  search,
  onOpen,
  onLink,
  onClose,
}: {
  machines: FinderMachine[]
  /** Preselected machine; empty searches all of them. */
  initialMachine?: string
  initialQuery?: string
  search: (machineId: string, input: ConversationSearch, signal: AbortSignal) => Promise<ConversationResults>
  /** Open a session Outpost already has for the conversation. */
  onOpen: (machineId: string, sessionId: string) => void
  /** Create a session that resumes the conversation. */
  onLink: (machineId: string, match: ConversationMatch) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState(initialQuery),
    [machine, setMachine] = useState(machines.some(item => item.id === initialMachine) ? initialMachine : ''),
    [tool, setTool] = useState<HarnessId | ''>('')
  const [results, setResults] = useState<FinderResults | null>(null)
  const [busy, setBusy] = useState(() => Boolean(initialQuery.trim()))
  const request = useRef<AbortController | null>(null)
  const scope = machine ? machines.filter(item => item.id === machine) : machines

  function run(event?: FormEvent) {
    event?.preventDefault()
    const term = query.trim()
    if (!term) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setResults(null)
    void runFinderSearch(term, tool, scope, search, controller.signal).then(outcome => {
      if (controller.signal.aborted) return
      if (request.current === controller) request.current = null
      setResults(outcome)
      setBusy(false)
    })
  }

  // A query handed over from another search box runs on mount (including StrictMode remount).
  const searchInitial = useEffectEvent((term: string, signal: AbortSignal) =>
    runFinderSearch(term, tool, scope, search, signal),
  )
  useEffect(() => {
    const term = initialQuery.trim()
    if (!term) return () => request.current?.abort()
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    void searchInitial(term, controller.signal).then(outcome => {
      if (controller.signal.aborted) return
      if (request.current === controller) request.current = null
      setResults(outcome)
      setBusy(false)
    })
    return () => controller.abort()
  }, [initialQuery])

  return (
    <Dialog
      size="large"
      drafts={false}
      title="Find a conversation"
      description="Searches the coding tools’ history on your machines, including conversations started outside Outpost. Nothing is copied to Outpost."
      onClose={onClose}
    >
      <form className="search-form" onSubmit={event => void run(event)}>
        <label className="field grow">
          <span className="sr-only">Search for</span>
          <input
            autoFocus
            value={query}
            maxLength={256}
            required
            placeholder="A phrase, error message or topic"
            onChange={event => {
              setQuery(event.target.value)
              setResults(null)
            }}
          />
        </label>
        {machines.length > 1 && (
          <select
            aria-label="Machine"
            value={machine}
            onChange={event => {
              setMachine(event.target.value)
              setResults(null)
            }}
          >
            <option value="">All machines</option>
            {machines.map(item => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label="Coding tool"
          value={tool}
          onChange={event => {
            setTool(event.target.value as HarnessId | '')
            setResults(null)
          }}
        >
          <option value="">All tools</option>
          {harnesses.map(harness => (
            <option key={harness.id} value={harness.id}>
              {harness.label}
            </option>
          ))}
        </select>
        <button className="button primary" disabled={busy || !query.trim()}>
          {busy ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />}Search
        </button>
      </form>
      {busy && (
        <p className="muted" role="status">
          {scope.length === 1 ? `Searching on ${scope[0].name}…` : `Searching ${scope.length} machines…`}
        </p>
      )}
      {results && (
        <>
          <p className="muted" role="status">
            {results.found.length} conversation{results.found.length === 1 ? '' : 's'}
            {results.truncated ? ' (partial results)' : ''}
          </p>
          {results.warnings.map(warning => (
            <p key={warning} className="warning">
              {warning}
            </p>
          ))}
          <ul className="matches">
            {results.found.map(match => {
              const managed = match.managedSessionIds[0]
              const linkable = match.rootDir.startsWith('/')
              return (
                <li key={`${match.machine.id}:${match.tool}:${match.conversation}:${JSON.stringify(match.storage)}`}>
                  <div className="match-text">
                    <div className="match-title">
                      <span className="chip">
                        <ToolIcon tool={match.tool} size={11} />
                        {harnessLabel(match.tool)}
                      </span>
                      <code>{match.conversation}</code>
                      {managed && <span className="chip accent">In Outpost</span>}
                    </div>
                    {match.excerpt && <p className="excerpt">{match.excerpt}</p>}
                    <small>
                      {machines.length > 1 && `${match.machine.name} · `}
                      <code>{match.rootDir || 'Unknown directory'}</code>
                      {match.updatedAt && ` · ${relativeTime(match.updatedAt)}`}
                    </small>
                  </div>
                  {managed ? (
                    <button className="button small" onClick={() => onOpen(match.machine.id, managed)}>
                      <ArrowRight size={14} />
                      Open
                    </button>
                  ) : (
                    <button
                      className="button small"
                      disabled={!linkable}
                      title={linkable ? undefined : 'Project directory is unknown'}
                      onClick={() => onLink(match.machine.id, match)}
                    >
                      <Link size={14} />
                      Link
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </Dialog>
  )
}
