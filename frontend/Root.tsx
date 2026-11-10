import { lazy, Suspense } from 'react'
import App from './App'
import AuthGate from './auth/AuthGate'
import { pagePaths } from '../shared/pages'

const DesktopTerminalPage = lazy(() => import('./terminal/DesktopTerminalPage'))
const DesktopDownloadPage = lazy(() => import('./desktop/DesktopDownloadPage'))
const TerminalPage = lazy(() => import('./terminal/TerminalPage'))
const DesktopAuthorizePage = lazy(() => import('./desktop/DesktopAuthorizePage'))
const ChatApp = lazy(() => import('./chat/ChatApp'))
const DesktopChatPage = lazy(() => import('./chat/DesktopChatPage'))

// The workspace address opens the mode used last on this browser.
function remembersChat() {
  try {
    return localStorage.getItem('outpost:mode') === 'chat'
  } catch {
    return false
  }
}
if (window.location.pathname === pagePaths.workspace && !window.location.search && remembersChat())
  window.history.replaceState(null, '', pagePaths.chat)

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
      ) : window.location.pathname === pagePaths.desktopChat ? (
        <DesktopChatPage />
      ) : window.location.pathname === pagePaths.desktopAuthorize ? (
        <AuthGate>
          <DesktopAuthorizePage requestId={new URLSearchParams(window.location.search).get('request') ?? ''} />
        </AuthGate>
      ) : (
        <AuthGate>
          {window.location.pathname === pagePaths.terminal ? (
            <TerminalPage />
          ) : window.location.pathname === pagePaths.chat ? (
            <ChatApp />
          ) : (
            <App />
          )}
        </AuthGate>
      )}
    </Suspense>
  )
}
