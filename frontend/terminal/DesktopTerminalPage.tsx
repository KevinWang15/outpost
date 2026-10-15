import { useState } from 'react'
import { pagePaths } from '../../shared/pages'
import { desktop } from '../desktop'
import TerminalView from './TerminalView'
import { saveDesktopTicket } from './desktopTicket'
import { openBrowserTab } from './browser'

export default function DesktopTerminalPage({ token: initial }: { token: string | null }) {
  const [token] = useState(initial)
  if (!token)
    return (
      <main className="auth-loading">
        <h1>Outpost Desktop</h1>
        <p>Choose a session in Outpost, then Connect → Outpost Desktop.</p>
        <button
          className="button primary"
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
      onResume={saveDesktopTicket}
      onExpired={() => saveDesktopTicket(null)}
      onClose={() => {
        saveDesktopTicket(null)
        if (desktop) void desktop.close()
        else {
          window.close()
          window.location.replace(pagePaths.workspace)
        }
      }}
    />
  )
}
