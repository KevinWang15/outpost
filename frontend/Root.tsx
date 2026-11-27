import { lazy, Suspense, useEffect } from 'react'
import { LoaderCircle } from 'lucide-react'
import { isGuidePath, pagePaths } from '../shared/pages'
import App from './App'
import AuthGate from './auth/AuthGate'
import { useRouteTransition, type RouteLocation } from './router'
import {
  loadChatApp,
  loadDesktopAuthorizePage,
  loadDesktopDownloadPage,
  loadGuidePage,
  loadLogsPage,
  loadTerminalPage,
  scheduleWorkspacePrefetch,
} from './routes'
import { WorkspaceShell, type SidebarPage } from './ui/AppSidebar'

const DesktopDownloadPage = lazy(loadDesktopDownloadPage)
const TerminalPage = lazy(loadTerminalPage)
const DesktopAuthorizePage = lazy(loadDesktopAuthorizePage)
const ChatApp = lazy(loadChatApp)
const LogsPage = lazy(loadLogsPage)
const GuidePage = lazy(loadGuidePage)

function PageFallback() {
  return (
    <div className="auth-loading" role="status">
      <LoaderCircle className="spin" size={20} />
    </div>
  )
}

function WorkspaceMainFallback() {
  return (
    <main className="content">
      <div className="empty page-empty" role="status">
        <LoaderCircle className="spin" size={20} />
      </div>
    </main>
  )
}

function sidebarPageFor(pathname: string): SidebarPage {
  if (pathname === pagePaths.chat) return 'chat'
  if (pathname === pagePaths.logs) return 'logs'
  if (isGuidePath(pathname)) return 'guide'
  return 'machines'
}

function AuthenticatedRoutes({ location, isPending }: { location: RouteLocation; isPending: boolean }) {
  useEffect(() => scheduleWorkspacePrefetch(), [])
  const { pathname, search } = location

  if (pathname === pagePaths.desktopAuthorize) {
    return (
      <Suspense fallback={<PageFallback />}>
        <DesktopAuthorizePage requestId={new URLSearchParams(search).get('request') ?? ''} />
      </Suspense>
    )
  }

  if (pathname === pagePaths.terminal) {
    return (
      <Suspense fallback={<PageFallback />}>
        <TerminalPage />
      </Suspense>
    )
  }

  const page = sidebarPageFor(pathname)

  return (
    <>
      {isPending && <div className="route-progress" role="progressbar" aria-label="Loading page" />}
      <WorkspaceShell page={page} location={location}>
        <Suspense fallback={<WorkspaceMainFallback />}>
          {page === 'chat' ? <ChatApp /> : page === 'logs' ? <LogsPage /> : page === 'guide' ? <GuidePage /> : <App />}
        </Suspense>
      </WorkspaceShell>
    </>
  )
}

export default function Root() {
  const { location, isPending } = useRouteTransition()
  if (location.pathname === pagePaths.desktop) {
    return (
      <Suspense fallback={<PageFallback />}>
        <DesktopDownloadPage />
      </Suspense>
    )
  }
  return (
    <AuthGate>
      <AuthenticatedRoutes location={location} isPending={isPending} />
    </AuthGate>
  )
}
