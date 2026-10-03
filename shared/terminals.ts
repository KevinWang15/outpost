export type TerminalOS = 'macos' | 'windows' | 'linux'
export const terminalOSLabels: Record<TerminalOS, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux' }

// Order within each OS is also the automatic launch fallback order.
export const terminalApps = [
  { id: 'macos-iterm2', os: 'macos', name: 'iTerm2', shell: 'bash' },
  { id: 'macos-terminal', os: 'macos', name: 'Terminal', shell: 'bash' },
  { id: 'macos-wezterm', os: 'macos', name: 'WezTerm', shell: 'bash' },
  { id: 'macos-kitty', os: 'macos', name: 'kitty', shell: 'bash' },
  { id: 'macos-alacritty', os: 'macos', name: 'Alacritty', shell: 'bash' },
  { id: 'windows-terminal', os: 'windows', name: 'Windows Terminal', shell: 'powershell' },
  { id: 'windows-console', os: 'windows', name: 'System terminal', shell: 'powershell' },
  { id: 'windows-wezterm', os: 'windows', name: 'WezTerm', shell: 'powershell' },
  { id: 'windows-alacritty', os: 'windows', name: 'Alacritty', shell: 'powershell' },
  { id: 'linux-gnome', os: 'linux', name: 'GNOME Terminal', shell: 'bash' },
  { id: 'linux-ptyxis', os: 'linux', name: 'Ptyxis', shell: 'bash' },
  { id: 'linux-konsole', os: 'linux', name: 'Konsole', shell: 'bash' },
  { id: 'linux-wezterm', os: 'linux', name: 'WezTerm', shell: 'bash' },
  { id: 'linux-kitty', os: 'linux', name: 'kitty', shell: 'bash' },
  { id: 'linux-alacritty', os: 'linux', name: 'Alacritty', shell: 'bash' },
  { id: 'linux-xfce', os: 'linux', name: 'Xfce Terminal', shell: 'bash' },
  { id: 'linux-xterm', os: 'linux', name: 'XTerm', shell: 'bash' },
] as const

export type TerminalId = typeof terminalApps[number]['id']
export interface DesktopTerminal {
  id: TerminalId
  os: TerminalOS
  name: string
  shell: 'bash' | 'powershell'
}
export interface DesktopAvailability {
  os: TerminalOS | null
  terminals: DesktopTerminal[]
  recommendedId: TerminalId | null
}
export type TerminalPreferences = Partial<Record<TerminalOS, TerminalId>>
export interface DesktopLaunchInput { terminalId?: TerminalId; preferences?: TerminalPreferences }

export function terminalOS(platform: string): TerminalOS | null {
  return ({ darwin: 'macos', win32: 'windows', linux: 'linux' } as Record<string, TerminalOS>)[platform] ?? null
}
