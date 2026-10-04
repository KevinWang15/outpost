import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowRight, Link, LoaderCircle, Search } from 'lucide-react'
import type { CodingSessionMatch, CodingSessionSearchResults, CodingTool, Session, Target } from '../shared/session-manager'
import { codingToolLabels } from '../shared/session-manager'
import { api } from './api'
import { Modal } from './ui'
import { useAuth } from './useAuth'

export default function CodingSessionFinder({ target, tools, canLink, onLink, onOpen, onClose }: {
  target: Target
  tools: CodingTool[]
  canLink: boolean
  onLink: (session: CodingSessionMatch) => void
  onOpen: (session: Session) => void
  onClose: () => void
}) {
  const hosted = useAuth().mode === 'hosted'
  const [query, setQuery] = useState('')
  const [tool, setTool] = useState<CodingTool | ''>('')
  const [results, setResults] = useState<CodingSessionSearchResults | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])

  function reset() {
    request.current?.abort()
    request.current = null
    setResults(null)
    setError('')
    setBusy(false)
    setOpening(null)
  }
  async function search(event: FormEvent) {
    event.preventDefault()
    if (!query.trim()) return
    reset()
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    try {
      const result = await api<CodingSessionSearchResults>(`/targets/${target.id}/coding-sessions/search`, 'POST',
        { query: query.trim(), ...(tool ? { tool } : {}) }, controller.signal)
      if (!controller.signal.aborted) setResults(result)
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message)
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false) }
    }
  }
  async function open(id: string) {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setOpening(id)
    setError('')
    try {
      const session = await api<Session>(`/targets/${target.id}/sessions/${id}`, 'GET', undefined, controller.signal)
      if (!controller.signal.aborted) onOpen(session)
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message)
    } finally {
      if (request.current === controller) { request.current = null; setOpening(null) }
    }
  }
  return <Modal title="Find coding sessions" subtitle={`Search conversations across ${target.name}, including sessions created outside the manager.`} onClose={onClose} className="coding-finder">
    <form className="coding-search-form" onSubmit={search}>
      <label>Conversation keyword
        <input autoFocus name="query" value={query} maxLength={256} required autoComplete="off"
          placeholder="A phrase, error message, or topic…" onChange={event => { reset(); setQuery(event.target.value) }} />
      </label>
      <label>Coding tool
        <select value={tool} onChange={event => { reset(); setTool(event.target.value as CodingTool | '') }}>
          <option value="">All coding tools</option>
          {Object.entries(codingToolLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <button className="button primary" disabled={busy || !query.trim()}>{busy ? <LoaderCircle className="loading-spinner" size={16} /> : <Search size={16} />} Search</button>
    </form>
    <p className="finder-privacy">Search runs on the target. Conversation files stay there; results are never saved by the manager.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {busy && <p role="status">Searching conversation files on the target…</p>}
    {results && <>
      <p role="status" className="finder-result-count">{results.sessions.length} matching conversation{results.sessions.length === 1 ? '' : 's'}{results.truncated ? ' · Partial results' : ''}</p>
      {results.warnings.map(message => <p key={message} className="finder-warning" role="status">{message}</p>)}
      {results.truncated && !results.warnings.length && <p className="finder-warning">Showing up to 50 matches. Use a more specific keyword or choose one coding tool.</p>}
      <ul className="coding-matches">
        {results.sessions.map(session => {
          const managed = session.managedSessionIds[0]
          const available = canLink && tools.includes(session.tool) && session.rootDir.startsWith('/')
          return <li key={`${session.tool}:${session.cliSessionId}:${JSON.stringify(session.cliSessionEnv)}`}>
            <div className="coding-match-content">
              <div className="coding-match-title"><span className="tag">{codingToolLabels[session.tool]}</span><strong>{session.title}</strong>{managed && <span className="tag">Managed</span>}</div>
              <code className="coding-match-root">{session.rootDir || 'Working directory unavailable'}</code>
              <code className="coding-match-id">{session.cliSessionId}</code>
              {session.excerpt && <p className="coding-excerpt">{session.excerpt}</p>}
              {session.updatedAt && <small>Updated {new Date(session.updatedAt).toLocaleString()}</small>}
              {!managed && !available && <small className="finder-warning">{session.rootDir ? `Check Required Software for ${codingToolLabels[session.tool]} and a session backend before linking.` : 'The CLI did not save a working directory for this conversation.'}</small>}
            </div>
            {managed ? <button className="button secondary" disabled={Boolean(opening)} onClick={() => void open(managed)}>{opening === managed ? <LoaderCircle size={15} className="loading-spinner" /> : <ArrowRight size={15} />} {hosted ? 'Connect using web terminal' : 'Connect'}</button>
              : <button className="button secondary" disabled={!available || Boolean(opening)} onClick={() => onLink(session)}><Link size={15} /> Link session</button>}
          </li>
        })}
      </ul>
    </>}
    <div className="modal-actions"><button className="button secondary" onClick={onClose}>Done</button></div>
  </Modal>
}
