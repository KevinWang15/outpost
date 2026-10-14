// A terminal grant is not an account login. Keep it in this window's session
// storage for reloads; never put a resume token in a link or localStorage.
const key = 'outpost.terminal-app.ticket'
const valid = (value: string | null): value is string =>
  value !== null && value.length <= 8192 && /^[\w-]+\.[\w-]+$/.test(value)

export function saveAppTicket(token: string | null) {
  try {
    if (token === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, token)
  } catch {
    // Storage can be disabled. The live socket still reconnects in memory.
  }
}

/** Called once at entry, before React (including StrictMode) or AuthGate.
 * Consume and erase even a malformed fragment, so it cannot revive an older
 * session or remain in browser history. The broker validates the signature. */
export function takeAppTicket() {
  if (window.location.hash) {
    const params = new URLSearchParams(window.location.hash.slice(1))
    window.history.replaceState(null, '', window.location.pathname)
    // Installed PWAs receive the same ticket through the browser's OS protocol
    // handler. Accept only our fixed envelope, never a URL to navigate to.
    const launch = params.get('launch')
    const prefix = 'web+outpost://connect/'
    const token = params.has('launch')
      ? launch?.startsWith(prefix)
        ? launch.slice(prefix.length)
        : null
      : params.get('token')
    const ticket = valid(token) ? token : null
    saveAppTicket(ticket)
    return ticket
  }
  try {
    const token = sessionStorage.getItem(key)
    return valid(token) ? token : null
  } catch {
    return null
  }
}
