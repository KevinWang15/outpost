import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { ConnectResponse } from '../../shared/protocol'
import { api } from '../api'
import TerminalView from './TerminalView'

export default function TerminalPage() {
  const query = new URLSearchParams(window.location.search)
  const target = query.get('target'),
    session = query.get('session')
  const title = query.get('title') || 'Web terminal'
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const previous = document.title
    document.title = `${title} · Outpost`
    return () => {
      document.title = previous
    }
  }, [title])

  useEffect(() => {
    if (!target || !session) return
    const controller = new AbortController()
    // Wait until committed so StrictMode's discarded effect cannot issue a launch.
    const start = setTimeout(() => {
      void api<ConnectResponse>(
        `/targets/${encodeURIComponent(target)}/sessions/${encodeURIComponent(session)}/connect`,
        'POST',
        { terminal: 'web' },
        controller.signal,
      ).then(
        connection => {
          if (!controller.signal.aborted) setToken(connection.token)
        },
        problem => {
          if (!controller.signal.aborted) setError(problem.message)
        },
      )
    }, 0)
    return () => {
      clearTimeout(start)
      controller.abort()
    }
  }, [target, session, attempt])

  if (token)
    return (
      <TerminalView
        token={token}
        title={title}
        onClose={() => {
          window.close()
          window.location.replace('/')
        }}
      />
    )

  return (
    <main className="auth-loading">
      <h1>{title}</h1>
      {!target || !session ? (
        <p role="alert">Choose a session in Outpost to open its web terminal.</p>
      ) : error ? (
        <>
          <p role="alert">{error}</p>
          <button
            className="button"
            onClick={() => {
              setError('')
              setAttempt(value => value + 1)
            }}
          >
            Try again
          </button>
        </>
      ) : (
        <p role="status">
          <LoaderCircle className="spin" size={18} /> Opening terminal…
        </p>
      )}
      <a href="/">Back to Outpost</a>
    </main>
  )
}
