/** The entire API available to the remote terminal. No generic IPC or Node access. */
export const desktopBridgeVersion = 1
export interface DesktopBridge {
  version: number
  notificationsSupported: boolean
  openExternal(url: string): Promise<boolean>
  onSelectAll(listener: () => void): () => void
  pasteClipboard(): Promise<boolean>
  copyText(text: string): Promise<boolean>
  notifyBell(name: string): Promise<boolean>
  dismissBell(): Promise<void>
  close(): Promise<void>
}

export const desktopReleases = 'https://github.com/KevinWang15/outpost/releases'
export interface DesktopLaunch {
  v: 1
  server: string
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
