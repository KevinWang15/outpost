import { useEffect, useState } from 'react'
import { pagePaths } from '../../shared/pages'
import { desktop, desktopProblem } from '../desktop'
import TerminalView from './TerminalView'
import { openBrowserTab } from './browser'
import { saveDesktopTicket } from './desktopTicket'

function remember(token: string, title: string) {
  if (desktop) return desktop.saveResume(token, title)
  saveDesktopTicket(token)
}

export default function DesktopTerminalPage({ token: initial }: { token: string | null }) {
  const [token, setToken] = useState(desktop ? null : initial)
  const [loading, setLoading] = useState(Boolean(desktop))
  const [error, setError] = useState('')
  useEffect(() => {
    if (!desktop) return
    let disposed = false
    void desktop.ticket().then(
      value => {
        if (disposed) return
        setToken(value)
        setLoading(false)
      },
      () => {
        if (disposed) return
        setError('Could not open this connection. Close the tab and try again from Outpost.')
        setLoading(false)
      },
    )
    return () => {
      disposed = true
    }
  }, [])
  if (desktopProblem)
    return (
      <main className="auth-loading" role="alert">
        <h1>Outpost update required</h1>
        <p>{desktopProblem}</p>
        <button className="button primary" onClick={() => window.location.reload()}>
          Reload terminal
        </button>
      </main>
    )
  if (!token)
    return (
      <main className="auth-loading">
        <h1>Outpost Desktop</h1>
        <p role={error ? 'alert' : 'status'}>
          {loading ? 'Opening terminal…' : error || 'Choose a session in Outpost, then Connect → Outpost Desktop.'}
        </p>
        <button
          className="button primary"
          disabled={loading}
          onClick={() => {
            void openBrowserTab(window.location.origin)
          }}
        >
          Open Outpost
        </button>
      </main>
    )
  return (
    <TerminalView
      token={token}
      title="Outpost Desktop"
      onResume={remember}
      onExpired={() => {
        if (!desktop) saveDesktopTicket(null)
      }}
      onClose={() => {
        if (desktop) void desktop.close()
        else {
          saveDesktopTicket(null)
          window.close()
          window.location.replace(pagePaths.workspace)
        }
      }}
    />
  )
}
