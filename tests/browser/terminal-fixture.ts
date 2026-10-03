import { terminalApps, type DesktopAvailability, type TerminalId, type TerminalOS } from '../../shared/terminals'

export function desktopAvailability(os: TerminalOS = 'linux', ids: TerminalId[] = []): DesktopAvailability {
  const terminals = terminalApps.filter(app => ids.includes(app.id))
  return { os, terminals, recommendedId: terminals[0]?.id ?? null }
}
