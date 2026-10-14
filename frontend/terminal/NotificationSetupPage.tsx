import { useEffect } from 'react'
import { Bell, LoaderCircle } from 'lucide-react'
import { notificationMessages, useBellNotifications } from './useBellNotifications'

/** Public browser settings page: no account APIs, terminal ticket, or connection. */
export default function NotificationSetupPage() {
  const notifications = useBellNotifications()
  useEffect(() => {
    document.title = 'Desktop notifications · Outpost'
  }, [])
  return (
    <main className="notification-setup">
      <img src="/outpost.svg" width="48" height="48" alt="Outpost" />
      <h1>Desktop notifications</h1>
      <p>Allow notifications for {window.location.host} in this browser, then return to your terminal.</p>
      <p role="status">
        {notifications.notice?.text ??
          (notifications.permission === 'default'
            ? 'Click Enable notifications, then choose Allow in the browser’s prompt.'
            : notificationMessages[notifications.permission])}
      </p>
      {notifications.permission === 'granted' && <p>You can close this tab and return to your terminal.</p>}
      {notifications.permission === 'default' && (
        <button className="button primary" disabled={notifications.requesting} onClick={notifications.request}>
          {notifications.requesting ? <LoaderCircle className="spin" size={17} /> : <Bell size={17} />}
          Enable notifications
        </button>
      )}
      {notifications.permission !== 'granted' && (
        <p>
          If the prompt is hidden or notifications are blocked, open the site controls beside the browser’s address bar.
          In Site settings / Permissions for this site, set Notifications to Allow.
        </p>
      )}
      <p className="muted">
        This setting is shared with terminal windows in this browser profile. Keep your terminal open to receive alerts.
        If alerts still do not appear, check Notifications and Focus / Do Not Disturb in Windows or macOS settings.
      </p>
    </main>
  )
}
