// Native terminal registry. Each entry has a connector adapter in
// connector/outpost_connector/terminals/; see docs/ARCHITECTURE.md.
export type ClientOS = 'macos' | 'windows'
export const clientOSLabels: Record<ClientOS, string> = { macos: 'macOS', windows: 'Windows' }

export interface NativeTerminal {
  id: string
  name: string
  os: ClientOS
  summary: string
  requirements: readonly string[]
  shortcuts: readonly { keys: string; action: string }[]
}

export const nativeTerminals = [
  {
    id: 'iterm2', name: 'iTerm2', os: 'macos',
    summary: 'Opens a tab with the Outpost profile',
    requirements: ['iTerm2 3.4 or newer', 'Python 3.9+ (Xcode Command Line Tools)'],
    shortcuts: [
      { keys: '⌘V', action: 'Paste text or an image' },
      { keys: '⇧↩', action: 'New line' },
      { keys: '⌥', action: 'Meta, for Alt shortcuts' },
    ],
  },
  {
    id: 'windows-terminal', name: 'Windows Terminal', os: 'windows',
    summary: 'Opens a WSL tab with the Outpost profile',
    requirements: ['Windows Terminal', 'WSL with Bash and Python 3'],
    shortcuts: [
      { keys: 'Ctrl+V', action: 'Paste text' },
      { keys: 'Alt+V', action: 'Paste an image' },
      { keys: 'Ctrl+Enter', action: 'New line' },
    ],
  },
] as const satisfies readonly NativeTerminal[]

export type NativeTerminalId = typeof nativeTerminals[number]['id']
export type TerminalChoice = 'web' | NativeTerminalId
export const terminalChoices: TerminalChoice[] = ['web', ...nativeTerminals.map(terminal => terminal.id)]
export const terminalName = (id: TerminalChoice) => id === 'web' ? 'Web terminal' : nativeTerminals.find(terminal => terminal.id === id)!.name

export function clientOS(userAgent: string): ClientOS | null {
  // iPadOS can identify as a Mac; the web terminal is always available.
  if (/Windows/i.test(userAgent)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(userAgent) && !/iPhone|iPad/i.test(userAgent)) return 'macos'
  return null
}
