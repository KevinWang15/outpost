import { useEffect, useState } from 'react'
import TerminalView from './TerminalView'
import { saveAppTicket, takeAppTicket } from './appTicket'

export default function TerminalAppPage({ token: initial }: { token: string | null }) {
  const [token, setToken] = useState(initial)
  useEffect(() => {
    // Browsers may deliver a link to an already-open app window.
    const launch = () => {
      if (window.location.hash) setToken(takeAppTicket())
    }
    window.addEventListener('hashchange', launch)
    return () => window.removeEventListener('hashchange', launch)
  }, [])
  if (!token)
    return (
      <main className="auth-loading">
        <h1>Outpost Terminal</h1>
        <p>Choose a session in Outpost, then Connect → Terminal app.</p>
        <a href="/">Open Outpost</a>
      </main>
    )

  return (
    <TerminalView
      key={token}
      token={token}
      title="Terminal app"
      onResume={saveAppTicket}
      onExpired={() => saveAppTicket(null)}
      onClose={() => {
        saveAppTicket(null)
        window.close()
        window.location.replace('/')
      }}
    />
  )
}
