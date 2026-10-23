import type { SessionActivity } from './activity'
import type { SessionFile } from './sessionFiles'

/** The entire API available to the remote terminal. No generic IPC or Node access. */
export const desktopBridgeVersion = 8
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
  downloadFile(file: SessionFile): Promise<boolean>
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
