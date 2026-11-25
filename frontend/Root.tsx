import { lazy, Suspense } from 'react'
import App from './App'
import AuthGate from './auth/AuthGate'
import { pagePaths } from '../shared/pages'

const DesktopDownloadPage = lazy(() => import('./desktop/DesktopDownloadPage'))
const TerminalPage = lazy(() => import('./terminal/TerminalPage'))
const DesktopAuthorizePage = lazy(() => import('./desktop/DesktopAuthorizePage'))
const ChatApp = lazy(() => import('./chat/ChatApp'))
const LogsPage = lazy(() => import('./logs/LogsPage'))
const GuidePage = lazy(() => import('./guide/GuidePage'))

export default function Root() {
  const pathname = window.location.pathname
  const isGuide = pathname === pagePaths.guide || pathname.startsWith(`${pagePaths.guide}/`)
  return (
    <Suspense
      fallback={
        <div className="auth-loading" role="status">
          Opening Outpost…
        </div>
      }
    >
      {pathname === pagePaths.desktop ? (
        <DesktopDownloadPage />
      ) : pathname === pagePaths.desktopAuthorize ? (
        <AuthGate>
          <DesktopAuthorizePage requestId={new URLSearchParams(window.location.search).get('request') ?? ''} />
        </AuthGate>
      ) : (
        <AuthGate>
          {pathname === pagePaths.terminal ? (
            <TerminalPage />
          ) : pathname === pagePaths.chat ? (
            <ChatApp />
          ) : pathname === pagePaths.logs ? (
            <LogsPage />
          ) : isGuide ? (
            <GuidePage />
          ) : (
            <App />
          )}
        </AuthGate>
      )}
    </Suspense>
  )
}
