/** Open directly from a click, with popup detection and no retained opener. */
export function openBrowserTab(url: string) {
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
