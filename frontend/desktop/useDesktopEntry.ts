import { desktopEntryUrl, type DesktopEntry } from '../../shared/desktopAuth'
import { useAuth } from '../auth/useAuth'

/** Both website buttons hand off intent synchronously within the user gesture.
 * Only the app's own authenticated API request can grant terminal access. */
export function useDesktopEntry() {
  const { user } = useAuth()
  return (session?: DesktopEntry['session']) =>
    window.location.assign(
      desktopEntryUrl({
        server: window.location.origin,
        accountId: user?.id ?? 'local',
        ...(session ? { session } : {}),
      }),
    )
}
