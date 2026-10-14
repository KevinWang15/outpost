import { useEffect, useState } from 'react'
import TerminalView from './TerminalView'
import { saveAppTicket, takeAppTicket } from './appTicket'
import { pagePaths } from '../../shared/pages'

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
      <main className="terminal-app-setup">
        <img src="/outpost.svg" width="48" height="48" alt="" />
        <h1>Outpost Terminal</h1>
        <p>Choose a session in Outpost, then Connect → Terminal app.</p>
        <a className="button primary" href={pagePaths.workspace}>
          Open Outpost
        </a>
        <h2>Add Outpost to your Dock</h2>
        <p>
          On macOS, install this page as an app in Chrome or Edge to give terminal windows their own Outpost icon in the
          Dock and app switcher.
        </p>
        <ol>
          <li>Open this page in Chrome or Edge.</li>
          <li>
            In Chrome, choose ⋮ → Cast, save, and share → Install page as app. In Edge, choose ⋯ → Apps → Install this
            site as an app.
          </li>
          <li>Update the Outpost connector, then connect to a session again using Terminal app.</li>
          <li>Allow Outpost Terminal to open its links if the browser asks.</li>
        </ol>
        <p>
          To keep the icon after closing your terminals, right-click it in the Dock and choose Options → Keep in Dock.
        </p>
        <p className="muted">
          Install once for each Outpost server. Opening the Dock shortcut brings you here; choose sessions through
          Outpost. Your existing terminal windows continue running while you set this up.
        </p>
      </main>
    )

  return (
    <TerminalView
      appWindow
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
