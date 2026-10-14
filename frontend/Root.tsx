import { lazy, Suspense } from 'react'
import App from './App'
import AuthGate from './auth/AuthGate'

const TerminalAppPage = lazy(() => import('./terminal/TerminalAppPage'))
const TerminalPage = lazy(() => import('./terminal/TerminalPage'))

/** Only the ticket entry bypasses account UI. The broker still authorizes
 * every connection; workspace routes always require the normal AuthGate. */
export default function Root({ terminalApp, ticket }: { terminalApp: boolean; ticket: string | null }) {
  return (
    <Suspense fallback={<div className="auth-loading">Opening terminal…</div>}>
      {terminalApp ? (
        <TerminalAppPage token={ticket} />
      ) : (
        <AuthGate>{window.location.pathname === '/terminal' ? <TerminalPage /> : <App />}</AuthGate>
      )}
    </Suspense>
  )
}
