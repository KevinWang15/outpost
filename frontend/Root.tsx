import { lazy, Suspense } from 'react'
import App from './App'
import AuthGate from './auth/AuthGate'
import { pagePaths } from '../shared/pages'

const DesktopTerminalPage = lazy(() => import('./terminal/DesktopTerminalPage'))
const DesktopDownloadPage = lazy(() => import('./desktop/DesktopDownloadPage'))
const TerminalPage = lazy(() => import('./terminal/TerminalPage'))
const DesktopAuthorizePage = lazy(() => import('./desktop/DesktopAuthorizePage'))

/** Scoped terminal grants authorize desktop views. Browser app approval and
 * workspace pages require the normal AuthGate. */
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
      ) : window.location.pathname === pagePaths.desktopAuthorize ? (
        <AuthGate>
          <DesktopAuthorizePage requestId={new URLSearchParams(window.location.search).get('request') ?? ''} />
        </AuthGate>
      ) : (
        <AuthGate>{window.location.pathname === pagePaths.terminal ? <TerminalPage /> : <App />}</AuthGate>
      )}
    </Suspense>
  )
}
