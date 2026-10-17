import type { SessionActivity } from './activity'

/** The entire API available to the remote terminal. No generic IPC or Node access. */
export const desktopBridgeVersion = 6
export interface TerminalPreferences {
  fontSize: number
  sound: boolean
}
export interface TerminalHostState extends TerminalPreferences {
  focused: boolean
}
export interface TerminalPaneState {
  title: string
  connection: 'connecting' | 'connected' | 'reconnecting' | 'closed'
  /** null only before the first observation or while disconnected. Failures are unknown. */
  activity: SessionActivity | null
  attention: boolean
  hasDraft: boolean
}
export type TerminalCommand = 'select-all' | 'focus' | 'reconnect' | 'resume' | 'find' | 'clear'
export interface DesktopBridge {
  version: number
  notificationsSupported: boolean
  /** Credential for this pane only, delivered in memory rather than a page URL. */
  ticket(): Promise<string | null>
  /** Called only after the server accepts a connection and issues a resume grant. */
  saveResume(token: string, title: string): Promise<void>
  openExternal(url: string): Promise<boolean>
  onCommand(listener: (command: TerminalCommand) => void): () => void
  onLaunch(listener: (token: string) => void): () => void
  launchHandled(token: string): Promise<void>
  onHostState(listener: (state: TerminalHostState) => void): () => void
  reportState(state: TerminalPaneState): Promise<void>
  pasteClipboard(): Promise<boolean>
  copyText(text: string): Promise<boolean>
  notifyBell(name: string): Promise<boolean>
  dismissBell(): Promise<void>
  close(): Promise<void>
}

export const desktopReleases = 'https://github.com/KevinWang15/outpost/releases'
export interface DesktopLaunch {
  v: 2
  server: string
  sessionKey: string
  token: string
  terminal: 'desktop'
  title: string
}

/** Desktop privileges require HTTPS, except a server on this computer. */
export function desktopOrigin(value: string): string {
  if (value.length > 2048 || /[\s\\]/.test(value)) throw new Error('Enter an Outpost server URL.')
  const url = new URL(value)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Use an HTTPS server address, or HTTP on localhost, without a path or credentials.')
  return url.origin
}
