import { contextBridge, ipcRenderer } from 'electron'
import { desktopBridgeVersion, type DesktopBridge } from '../../shared/desktop'

const bridge: DesktopBridge = {
  version: desktopBridgeVersion,
  notificationsSupported: process.argv.includes('--outpost-notifications'),
  onSelectAll: listener => {
    const handle = () => listener()
    ipcRenderer.on('terminal:select-all', handle)
    return () => {
      ipcRenderer.removeListener('terminal:select-all', handle)
    }
  },
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
