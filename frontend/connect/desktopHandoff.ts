/** Browsers do not acknowledge custom-protocol launches. Focus/visibility only
 * control optional help; neither is proof that the app connected a session. */
export function observeDesktopHandoff(onLeave: () => void, onHelp: () => void) {
  const events = new AbortController()
  const options = { signal: events.signal }
  const cancel = () => {
    clearTimeout(timer)
    events.abort()
  }
  const leave = () => {
    cancel()
    onLeave()
  }
  const timer = window.setTimeout(() => {
    // The page can lose focus while the OS protocol prompt blocks event delivery.
    if (document.hidden || !document.hasFocus()) leave()
    else {
      window.removeEventListener('pointerdown', cancel)
      window.removeEventListener('keydown', cancel)
      onHelp()
    }
  }, 2000)
  window.addEventListener('blur', leave, options)
  window.addEventListener('pagehide', leave, options)
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) leave()
    },
    options,
  )
  // If the user continues working in the web UI, do not interrupt with late help.
  window.addEventListener('pointerdown', cancel, options)
  window.addEventListener('keydown', cancel, options)
  return cancel
}
