import { lazy, Suspense } from 'react'
import App from './App'
import AuthGate from './auth/AuthGate'
import { pagePaths } from '../shared/pages'

const TerminalAppPage = lazy(() => import('./terminal/TerminalAppPage'))
const TerminalPage = lazy(() => import('./terminal/TerminalPage'))
const NotificationSetupPage = lazy(() => import('./terminal/NotificationSetupPage'))

/** Ticket entry and browser permission setup bypass account UI. The broker
 * authorizes every connection; workspace routes require the normal AuthGate. */
export default function Root({ terminalApp, ticket }: { terminalApp: boolean; ticket: string | null }) {
  return (
    <Suspense fallback={<div className="auth-loading">Opening terminal…</div>}>
      {window.location.pathname === pagePaths.notifications ? (
        <NotificationSetupPage />
      ) : terminalApp ? (
        <TerminalAppPage token={ticket} />
      ) : (
        <AuthGate>{window.location.pathname === pagePaths.terminal ? <TerminalPage /> : <App />}</AuthGate>
      )}
    </Suspense>
  )
}
