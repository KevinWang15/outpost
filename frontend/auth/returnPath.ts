import { pagePaths } from '../../shared/pages'
import { validDesktopProof } from '../../shared/desktopAuth'

/** Only the app authorization page can resume after account sign-in. Never redirect to an arbitrary URL. */
export function desktopReturnPath(value: string | null) {
  if (!value || !value.startsWith('/')) return null
  try {
    const url = new URL(value, window.location.origin)
    const request = url.searchParams.get('request')
    if (
      url.origin !== window.location.origin ||
      url.pathname !== pagePaths.desktopAuthorize ||
      !validDesktopProof(request)
    )
      return null
    return `${pagePaths.desktopAuthorize}?request=${request}`
  } catch {
    return null
  }
}
