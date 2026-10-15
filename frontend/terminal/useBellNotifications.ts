import { useCallback, useEffect, useRef, useState } from 'react'
import { bellNotificationPermission, type BellNotificationPermission } from './bell'
import { desktop } from '../desktop'

export const notificationLabels: Record<BellNotificationPermission, string> = {
  default: 'Enable desktop notifications',
  granted: 'Desktop notifications enabled',
  denied: 'Desktop notifications blocked',
  unsupported: 'Desktop notifications unavailable in this browser',
  insecure: 'Desktop notifications require HTTPS or localhost',
}
const notificationMessages: Record<BellNotificationPermission, string> = {
  default: 'Desktop notifications were not enabled. Try again or check the site’s notification settings.',
  granted: 'Desktop notifications enabled. Keep the terminal open to receive alerts.',
  denied: 'Notifications are blocked. Allow them in your browser’s site settings.',
  unsupported: 'This browser does not support desktop notifications.',
  insecure: 'Open Outpost over HTTPS or localhost to enable notifications.',
}
const waitingMessage = 'Still waiting for the browser’s permission prompt. Check the site’s notification settings.'
type Notice = { text: string; sticky: boolean }
type PermissionRequest = { timer?: ReturnType<typeof setTimeout> }
type State = { permission: BellNotificationPermission; requesting: boolean }
const noticeFor = (permission: BellNotificationPermission): Notice => ({
  text:
    desktop && permission === 'granted'
      ? 'Outpost desktop alerts are enabled. If they do not appear, allow Outpost in your system notification settings and check Focus / Do Not Disturb.'
      : notificationMessages[permission],
  sticky: permission !== 'granted',
})

/** Browser permission is requested by the terminal's bell button. Electron
 * supplies native notifications; an unanswered browser prompt must not trap the UI. */
export function useBellNotifications(onNotice: (message: string, sticky: boolean) => void) {
  const [state, setState] = useState<State>(() => ({ permission: bellNotificationPermission(), requesting: false }))
  const current = useRef(state)
  const requested = useRef(false)
  const publish = useCallback(
    (next: State, notice?: Notice) => {
      current.current = next
      setState(next)
      if (notice) onNotice(notice.text, notice.sticky)
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
      publish({ permission, requesting: false }, requested.current ? noticeFor(permission) : undefined)
    return permission
  }, [clearPending, publish])

  useEffect(() => {
    let disposed = false
    let permissionStatus: PermissionStatus | undefined
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    // Watch site-setting changes while open; focus also refreshes browsers
    // without a notification Permissions API implementation.
    if (!desktop)
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
    requested.current = true
    const permission = refresh()
    if (permission !== 'default') {
      publish({ permission, requesting: false }, noticeFor(permission))
      return
    }
    if (pending.current) {
      publish({ permission, requesting: false }, { text: waitingMessage, sticky: true })
      return
    }
    const attempt: PermissionRequest = {}
    pending.current = attempt
    publish(
      { permission, requesting: true },
      { text: 'Allow notifications in your browser’s permission prompt.', sticky: true },
    )
    const finish = (failed = false) => {
      if (pending.current !== attempt) return
      clearPending()
      const next = bellNotificationPermission()
      publish(
        { permission: next, requesting: false },
        failed && next === 'default'
          ? { text: 'Could not enable desktop notifications. Check your browser’s site settings.', sticky: true }
          : noticeFor(next),
      )
    }
    attempt.timer = setTimeout(() => {
      if (pending.current !== attempt) return
      const next = refresh()
      if (next !== 'default') return
      // Release the busy indicator while observing the original request's late answer.
      publish({ permission: next, requesting: false }, { text: waitingMessage, sticky: true })
    }, 8000)
    try {
      // Stay in the click handler's synchronous stack to preserve user activation.
      void Notification.requestPermission().then(
        () => finish(),
        () => finish(true),
      )
    } catch {
      finish(true)
    }
  }

  return { ...state, request }
}
