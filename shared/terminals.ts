// Connector terminal registry. Each entry has a launcher adapter in
// connector/outpost_connector/terminals/; see docs/ARCHITECTURE.md.
export type ClientOS = 'macos' | 'windows'
export const clientOSLabels: Record<ClientOS, string> = { macos: 'macOS', windows: 'Windows' }

export interface ConnectorTerminal {
  id: string
  name: string
  os: readonly ClientOS[]
  summary: string
  requirements: readonly string[]
  shortcuts: readonly { keys: string; action: string }[]
}

export const connectorTerminals = [
  {
    id: 'terminal-app',
    name: 'Terminal app',
    os: ['macos', 'windows'],
    summary: 'The web terminal in its own window, without browser tabs or an address bar',
    requirements: ['Google Chrome or Microsoft Edge', 'macOS: Python 3.9+; Windows: WSL with Bash and Python 3'],
    shortcuts: [{ keys: '⇧↩', action: 'New line' }],
  },
  {
    id: 'iterm2',
    name: 'iTerm2',
    os: ['macos'],
    summary: 'Opens a tab with the Outpost profile',
    requirements: ['iTerm2 3.4 or newer', 'Python 3.9+ (Xcode Command Line Tools)'],
    shortcuts: [
      { keys: '⌘V', action: 'Paste text or an image' },
      { keys: '⇧↩', action: 'New line' },
      { keys: '⌥', action: 'Meta, for Alt shortcuts' },
    ],
  },
  {
    id: 'windows-terminal',
    name: 'Windows Terminal',
    os: ['windows'],
    summary: 'Opens a WSL tab with the Outpost profile',
    requirements: ['Windows Terminal', 'WSL with Bash and Python 3'],
    shortcuts: [
      { keys: 'Ctrl+V', action: 'Paste text' },
      { keys: 'Alt+V', action: 'Paste an image' },
      { keys: 'Ctrl+Enter', action: 'New line' },
    ],
  },
] as const satisfies readonly ConnectorTerminal[]

export type ConnectorTerminalId = (typeof connectorTerminals)[number]['id']
export type TerminalChoice = 'web' | ConnectorTerminalId
export const terminalChoices: TerminalChoice[] = ['web', ...connectorTerminals.map(terminal => terminal.id)]
export const terminalName = (id: TerminalChoice) =>
  id === 'web' ? 'Web terminal' : connectorTerminals.find(terminal => terminal.id === id)!.name

export function clientOS(userAgent: string): ClientOS | null {
  // iPadOS can identify as a Mac; the web terminal is always available.
  if (/Windows/i.test(userAgent)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(userAgent) && !/iPhone|iPad/i.test(userAgent)) return 'macos'
  return null
}
