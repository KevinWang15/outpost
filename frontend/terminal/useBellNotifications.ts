import { useCallback, useEffect, useRef, useState } from 'react'
import { bellNotificationPermission, type BellNotificationPermission } from './bell'
import { pagePaths } from '../../shared/pages'
import { openBrowserTab } from './browser'

export const notificationLabels: Record<BellNotificationPermission, string> = {
  default: 'Enable desktop notifications',
  granted: 'Desktop notifications enabled',
  denied: 'Desktop notifications blocked',
  unsupported: 'Desktop notifications unavailable in this browser',
  insecure: 'Desktop notifications require HTTPS or localhost',
}
export const notificationMessages: Record<BellNotificationPermission, string> = {
  default: 'Desktop notifications were not enabled. Try again or check the site’s notification settings.',
  granted: 'Desktop notifications enabled. Keep the terminal open to receive alerts.',
  denied: 'Notifications are blocked. Allow them in your browser’s site settings.',
  unsupported: 'This browser does not support desktop notifications.',
  insecure: 'Open Outpost over HTTPS or localhost to enable notifications.',
}
const waitingMessage = 'Still waiting for the browser’s permission prompt. Check the site’s notification settings.'
type Notice = { text: string; sticky: boolean }
type PermissionRequest = { timer?: ReturnType<typeof setTimeout> }
type State = {
  permission: BellNotificationPermission
  requesting: boolean
  notice: Notice | null
}
const noticeFor = (permission: BellNotificationPermission): Notice => ({
  text: notificationMessages[permission],
  sticky: permission !== 'granted',
})

/** Permission belongs to the browser profile and origin, independently of login
 * or terminal tickets. A hidden browser prompt may never settle its promise. */
export function useBellNotifications(onNotice?: (message: string, sticky: boolean) => void) {
  const [state, setState] = useState<State>(() => ({
    permission: bellNotificationPermission(),
    requesting: false,
    notice: null,
  }))
  const current = useRef(state)
  const publish = useCallback(
    (next: State) => {
      current.current = next
      setState(next)
      if (next.notice) onNotice?.(next.notice.text, next.notice.sticky)
    },
    [onNotice],
  )
  const pending = useRef<PermissionRequest | null>(null)
  const clearPending = useCallback(() => {
    clearTimeout(pending.current?.timer)
    pending.current = null
  }, [])
  const refresh = useCallback(() => {
    const permission = bellNotificationPermission()
    if (permission !== 'default') clearPending()
    if (permission !== current.current.permission)
      publish({ permission, requesting: false, notice: current.current.notice ? noticeFor(permission) : null })
    return permission
  }, [clearPending, publish])

  useEffect(() => {
    let disposed = false
    let permissionStatus: PermissionStatus | undefined
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    // Chrome/Edge notify app windows when permission is changed in another tab.
    // Focus/visibility remain the fallback where this query is unsupported.
    void navigator.permissions
      ?.query({ name: 'notifications' })
      .then(status => {
        if (disposed) return
        permissionStatus = status
        status.addEventListener('change', refresh)
        refresh()
      })
      .catch(() => {})
    return () => {
      disposed = true
      clearPending()
      permissionStatus?.removeEventListener('change', refresh)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [clearPending, refresh])

  const request = () => {
    const permission = refresh()
    if (permission !== 'default') {
      publish({ permission, requesting: false, notice: noticeFor(permission) })
      return
    }
    if (pending.current) {
      publish({ permission, requesting: false, notice: { text: waitingMessage, sticky: true } })
      return
    }
    const attempt: PermissionRequest = {}
    pending.current = attempt
    publish({
      permission,
      requesting: true,
      notice: { text: 'Allow notifications in your browser’s permission prompt.', sticky: true },
    })
    const finish = (failed = false) => {
      if (pending.current !== attempt) return
      clearPending()
      const next = bellNotificationPermission()
      publish({
        permission: next,
        requesting: false,
        notice:
          failed && next === 'default'
            ? { text: 'Could not enable desktop notifications. Check your browser’s site settings.', sticky: true }
            : noticeFor(next),
      })
    }
    attempt.timer = setTimeout(() => {
      if (pending.current !== attempt) return
      const next = refresh()
      if (next !== 'default') return
      // This releases the UI, not the browser request. Observe late answers and
      // avoid stacking more prompts while the original request is still pending.
      publish({ permission: next, requesting: false, notice: { text: waitingMessage, sticky: true } })
    }, 8000)
    try {
      // Keep this in the click handler's synchronous call stack for user activation.
      void Notification.requestPermission().then(
        () => finish(),
        () => finish(true),
      )
    } catch {
      finish(true)
    }
  }

  const openSetup = () => {
    const permission = refresh()
    if (permission !== 'default' && permission !== 'denied') {
      publish({ permission, requesting: false, notice: noticeFor(permission) })
      return
    }
    // App windows can leave native permission prompts hidden indefinitely.
    // Open site controls in a regular tab directly from the user's click,
    // without first creating an unresolved request in the app window.
    const opened = openBrowserTab(new URL(pagePaths.notifications, window.location.origin).href)
    publish({
      permission,
      requesting: false,
      notice: {
        text: opened
          ? 'Allow notifications in the setup tab, then return here. Use the same browser and profile as this terminal.'
          : 'The setup tab was blocked. Open notification setup below and allow notifications in this browser.',
        sticky: true,
      },
    })
  }

  return {
    ...state,
    request,
    openSetup,
    needsSetup: state.notice !== null && (state.permission === 'default' || state.permission === 'denied'),
  }
}
