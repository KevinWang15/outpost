import { browserUrl } from '../../shared/signals'
import { desktop, desktopProblem } from '../desktop'

/** Browser opens stay in the click's call stack; desktop uses the OS default browser. */
export async function openBrowserTab(url: string) {
  if (desktopProblem) return false
  try {
    url = browserUrl({ url })
  } catch {
    return false
  }
  if (desktop) {
    try {
      return await desktop.openExternal(url)
    } catch {
      return false
    }
  }
  const tab = window.open('about:blank', '_blank')
  if (!tab) return false
  try {
    tab.opener = null
    tab.location.replace(url)
    return true
  } catch {
    tab.close()
    return false
  }
}
