export const terminalTheme = {
  background: '#0f172a',
  foreground: '#e2e8f0',
  cursor: '#93c5fd',
  cursorAccent: '#0f172a',
  selectionBackground: '#334155',
  black: '#1e293b',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e2e8f0',
  brightBlack: '#64748b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#f8fafc',
}

/** Outpost Desktop renders terminals on neutral black, like a native terminal
 * app. ANSI hues match the web palette so program output reads the same. */
export const desktopTerminalTheme = {
  ...terminalTheme,
  background: '#0c0c0c',
  foreground: '#e6e6e6',
  cursor: '#e6e6e6',
  cursorAccent: '#0c0c0c',
  selectionBackground: '#3d3d3d',
  black: '#262626',
  white: '#d4d4d4',
  brightBlack: '#737373',
  brightWhite: '#fafafa',
}
