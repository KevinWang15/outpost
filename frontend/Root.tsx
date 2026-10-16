import { lazy, Suspense } from 'react'
import App from './App'
import AuthGate from './auth/AuthGate'
import { pagePaths } from '../shared/pages'

const DesktopTerminalPage = lazy(() => import('./terminal/DesktopTerminalPage'))
const DesktopDownloadPage = lazy(() => import('./desktop/DesktopDownloadPage'))
const TerminalPage = lazy(() => import('./terminal/TerminalPage'))

/** Desktop entry pages bypass account UI. The broker
 * authorizes every connection; workspace routes require the normal AuthGate. */
export default function Root() {
  return (
    <Suspense
      fallback={
        <div className="auth-loading" role="status">
          Opening terminal…
        </div>
      }
    >
      {window.location.pathname === pagePaths.desktop ? (
        <DesktopDownloadPage />
      ) : window.location.pathname === pagePaths.desktopTerminal ? (
        <DesktopTerminalPage />
      ) : (
        <AuthGate>{window.location.pathname === pagePaths.terminal ? <TerminalPage /> : <App />}</AuthGate>
      )}
    </Suspense>
  )
}
