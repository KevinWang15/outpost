import { terminalChoices, type TerminalChoice } from '../../shared/terminals'

// A browser preference for this Outpost origin, independent of login credentials.
const key = 'outpost.connection.terminal'

export function preferredTerminal(): TerminalChoice | null {
  try {
    const value = localStorage.getItem(key)
    return terminalChoices.find(terminal => terminal === value) ?? null
  } catch {
    return null
  }
}

export function setPreferredTerminal(terminal: TerminalChoice | null) {
  try {
    if (terminal) localStorage.setItem(key, terminal)
    else localStorage.removeItem(key)
  } catch {
    throw new Error('Could not save your connection preference. Allow browser storage for Outpost and try again.')
  }
}
