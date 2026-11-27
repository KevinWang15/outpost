// Centralized lazy page loaders and background/hover chunk prefetching.
import { isGuidePath, pagePaths } from '../shared/pages'

export const loadDesktopDownloadPage = () => import('./desktop/DesktopDownloadPage')
export const loadDesktopAuthorizePage = () => import('./desktop/DesktopAuthorizePage')
export const loadTerminalPage = () => import('./terminal/TerminalPage')
export const loadChatApp = () => import('./chat/ChatApp')
export const loadLogsPage = () => import('./logs/LogsPage')
export const loadGuidePage = () => import('./guide/GuidePage')

/** Warm the JS/CSS chunk for an in-app route before the user completes a click. */
export function prefetchRoute(to: string) {
  if (typeof window === 'undefined') return
  let pathname: string
  try {
    const url = new URL(to, window.location.href)
    if (url.origin !== window.location.origin) return
    pathname = url.pathname
  } catch {
    return
  }
  if (pathname === pagePaths.chat) void loadChatApp().catch(() => {})
  else if (pathname === pagePaths.logs) void loadLogsPage().catch(() => {})
  else if (isGuidePath(pathname)) void loadGuidePage().catch(() => {})
  else if (pathname === pagePaths.desktop) void loadDesktopDownloadPage().catch(() => {})
}

let workspaceWarmed = false

/** Quietly prefetch the lightweight workspace routes during idle time once authenticated. */
export function scheduleWorkspacePrefetch(): () => void {
  if (workspaceWarmed || typeof window === 'undefined') return () => {}
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData
  if (saveData) return () => {}

  const warm = () => {
    if (workspaceWarmed) return
    workspaceWarmed = true
    void loadLogsPage().catch(() => {})
    void loadGuidePage().catch(() => {})
    void loadChatApp().catch(() => {})
  }

  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(warm, { timeout: 1500 })
    return () => window.cancelIdleCallback(id)
  }
  const timer = window.setTimeout(warm, 800)
  return () => window.clearTimeout(timer)
}
