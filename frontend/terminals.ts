import { terminalApps, type TerminalOS, type TerminalId, type TerminalPreferences } from '../shared/terminals'

export function browserOS(): TerminalOS | null {
  // iPadOS can identify as a Mac; copying commands is still available on every OS.
  if (/Windows/i.test(navigator.userAgent)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(navigator.userAgent)) return 'macos'
  if (/Linux|X11/i.test(navigator.userAgent)) return 'linux'
  return null
}

export function terminalPreferences(): TerminalPreferences {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('outpost-terminal-apps') ?? '{}')
    if (!saved || typeof saved !== 'object') return {}
    return Object.fromEntries(['macos', 'windows', 'linux'].flatMap(os => {
      const id = (saved as Record<string, unknown>)[os]
      return terminalApps.some(app => app.os === os && app.id === id) ? [[os, id]] : []
    }))
  } catch { return {} }
}

export function rememberTerminal(id: TerminalId) {
  const app = terminalApps.find(app => app.id === id)!
  try { localStorage.setItem('outpost-terminal-apps', JSON.stringify({ ...terminalPreferences(), [app.os]: id })) }
  catch { /* Selection still works when browser storage is unavailable. */ }
}

export function orderedTerminalOS(first: TerminalOS | null, manager: TerminalOS | null): TerminalOS[] {
  return [...new Set([first, manager, 'macos', 'windows', 'linux'].filter((os): os is TerminalOS => os !== null))]
}
