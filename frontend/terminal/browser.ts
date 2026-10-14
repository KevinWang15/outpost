import { desktop } from '../desktop'

/** Browser opens stay in the click's call stack; desktop uses the OS default browser. */
export async function openBrowserTab(url: string) {
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
