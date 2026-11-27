import { browserUrl } from '../../shared/signals'

export function openBrowserTab(url: string) {
  try {
    url = browserUrl({ url })
  } catch {
    return false
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
