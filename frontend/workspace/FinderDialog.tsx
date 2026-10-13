import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, Link, LoaderCircle, Search } from 'lucide-react'
import type { ConversationMatch, ConversationResults, Session, Target } from '../../shared/model'
import { harnesses, harnessLabel, type HarnessId } from '../../shared/harnesses'
import { api } from '../api'
import { Dialog } from '../ui/Dialog'
import { relativeTime } from './labels'

/** Search conversation history on the target, including conversations started outside Outpost. */
export default function FinderDialog({ target, tools, onLink, onConnect, onClose }: {
  target: Target
  tools: HarnessId[]
  onLink: (match: ConversationMatch) => void
  onConnect: (session: Session) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState(''), [tool, setTool] = useState<HarnessId | ''>('')
  const [results, setResults] = useState<ConversationResults | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])

  async function run<T>(work: (signal: AbortSignal) => Promise<T>) {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setError('')
    try { return await work(controller.signal) }
    catch (problem) { if (!controller.signal.aborted) setError((problem as Error).message) }
    finally { if (request.current === controller) request.current = null }
  }
  async function search(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setResults(null)
    const found = await run(signal => api<ConversationResults>(`/targets/${target.id}/conversations/search`, 'POST', { query: query.trim(), ...(tool ? { tool } : {}) }, signal))
    if (found) setResults(found)
    setBusy(false)
  }
  async function open(id: string) {
    setOpening(id)
    const session = await run(signal => api<Session>(`/targets/${target.id}/sessions/${id}`, 'GET', undefined, signal))
    setOpening(null)
    if (session) onConnect(session)
  }

  return <Dialog size="large" title="Find a conversation" description={`Searches conversation history on ${target.name}. Nothing is copied to Outpost.`} onClose={onClose}>
    <form className="search-form" onSubmit={search}>
      <label className="field grow"><span className="sr-only">Keyword</span>
        <input autoFocus value={query} maxLength={256} required placeholder="A phrase, error message or topic" onChange={event => { setQuery(event.target.value); setResults(null) }} />
      </label>
      <select aria-label="Coding tool" value={tool} onChange={event => { setTool(event.target.value as HarnessId | ''); setResults(null) }}>
        <option value="">All tools</option>
        {harnesses.map(harness => <option key={harness.id} value={harness.id}>{harness.label}</option>)}
      </select>
      <button className="button primary" disabled={busy || !query.trim()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />}Search</button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    {busy && <p className="muted" role="status">Searching on the target…</p>}
    {results && <>
      <p className="muted" role="status">{results.sessions.length} conversation{results.sessions.length === 1 ? '' : 's'}{results.truncated ? ' (partial results)' : ''}</p>
      {results.warnings.map(warning => <p key={warning} className="warning">{warning}</p>)}
      <ul className="matches">
        {results.sessions.map(match => {
          const managed = match.managedSessionIds[0]
          const linkable = tools.includes(match.tool) && match.rootDir.startsWith('/')
          return <li key={`${match.tool}:${match.cliSessionId}:${JSON.stringify(match.cliSessionEnv)}`}>
            <div className="match-text">
              <div className="match-title"><span className="chip">{harnessLabel(match.tool)}</span><strong>{match.title}</strong>{managed && <span className="chip accent">In Outpost</span>}</div>
              {match.excerpt && <p className="excerpt">{match.excerpt}</p>}
              <small><code>{match.rootDir || 'Unknown directory'}</code>{match.updatedAt && ` · ${relativeTime(match.updatedAt)}`}</small>
            </div>
            {managed
              ? <button className="button small" disabled={Boolean(opening)} onClick={() => void open(managed)}>{opening === managed ? <LoaderCircle className="spin" size={14} /> : <ArrowRight size={14} />}Connect</button>
              : <button className="button small" disabled={!linkable} title={linkable ? undefined : `Add ${harnessLabel(match.tool)} to this target to link it`} onClick={() => onLink(match)}><Link size={14} />Link</button>}
          </li>
        })}
      </ul>
    </>}
  </Dialog>
}
