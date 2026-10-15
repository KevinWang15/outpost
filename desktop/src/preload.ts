import { contextBridge, ipcRenderer } from 'electron'
import { desktopBridgeVersion, type DesktopBridge } from '../../shared/desktop'

const bridge: DesktopBridge = {
  version: desktopBridgeVersion,
  notificationsSupported: process.argv.includes('--outpost-notifications'),
  onCommand: listener => {
    const handle = (_event: Electron.IpcRendererEvent, command: Parameters<typeof listener>[0]) => listener(command)
    ipcRenderer.on('terminal:command', handle)
    return () => {
      ipcRenderer.removeListener('terminal:command', handle)
    }
  },
  onLaunch: listener => {
    let disposed = false
    const handle = (_event: Electron.IpcRendererEvent, token: string) => listener(token)
    ipcRenderer.on('terminal:launch', handle)
    // Reading does not consume: StrictMode cleanup or a loading renderer must
    // not drop the launch. The renderer acknowledges it after handling it.
    void ipcRenderer
      .invoke('terminal:pending-launches')
      .then((tokens: string[]) => {
        if (!disposed) for (const token of tokens) listener(token)
      })
      .catch(() => {})
    return () => {
      disposed = true
      ipcRenderer.removeListener('terminal:launch', handle)
    }
  },
  launchHandled: token => ipcRenderer.invoke('terminal:launch-handled', token),
  onHostState: listener => {
    let disposed = false
    let received = false
    const handle = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => {
      received = true
      listener(state)
    }
    ipcRenderer.on('terminal:host-state', handle)
    void ipcRenderer
      .invoke('terminal:host-state')
      .then(state => {
        // A live focus update supersedes an older initial snapshot in flight.
        if (!disposed && !received) listener(state)
      })
      .catch(() => {})
    return () => {
      disposed = true
      ipcRenderer.removeListener('terminal:host-state', handle)
    }
  },
  reportState: state => ipcRenderer.invoke('terminal:state', state),
  openExternal: (url: string) => ipcRenderer.invoke('terminal:open-external', url),
  // This check runs in the isolated preload world, outside renderer scripts.
  pasteClipboard: () =>
    navigator.userActivation.isActive ? ipcRenderer.invoke('terminal:paste') : Promise.resolve(false),
  copyText: (text: string) => ipcRenderer.invoke('terminal:copy', text),
  notifyBell: (name: string) => ipcRenderer.invoke('terminal:bell', name),
  dismissBell: () => ipcRenderer.invoke('terminal:dismiss-bell'),
  close: () => ipcRenderer.invoke('terminal:close'),
}
contextBridge.exposeInMainWorld('outpostDesktop', Object.freeze(bridge))
