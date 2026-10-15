import { contextBridge, ipcRenderer } from 'electron'
import type { WorkspaceBridge, WorkspaceSnapshot } from './workspace-api'

const bridge: WorkspaceBridge = {
  state: () => ipcRenderer.invoke('workspace:state'),
  onState: listener => {
    const handle = (_event: Electron.IpcRendererEvent, state: WorkspaceSnapshot) => listener(state)
    ipcRenderer.on('workspace:state', handle)
    return () => {
      ipcRenderer.removeListener('workspace:state', handle)
    }
  },
  activate: id => ipcRenderer.invoke('workspace:activate', id),
  close: id => ipcRenderer.invoke('workspace:close', id),
  reorder: (id, before) => ipcRenderer.invoke('workspace:reorder', id, before),
  rename: (id, label) => ipcRenderer.invoke('workspace:rename', id, label),
  panel: panel => ipcRenderer.invoke('workspace:panel', panel),
  pair: id => ipcRenderer.invoke('workspace:pair', id),
  split: direction => ipcRenderer.invoke('workspace:split', direction),
  ratio: ratio => ipcRenderer.invoke('workspace:ratio', ratio),
  contextMenu: id => ipcRenderer.invoke('workspace:context-menu', id),
  reload: id => ipcRenderer.invoke('workspace:reload', id),
  openServer: origin => ipcRenderer.invoke('workspace:open-server', origin),
  forgetServer: origin => ipcRenderer.invoke('workspace:forget-server', origin),
  preferences: value => ipcRenderer.invoke('workspace:preferences', value),
  checkUpdates: () => ipcRenderer.invoke('workspace:updates'),
}
contextBridge.exposeInMainWorld('outpostWorkspace', Object.freeze(bridge))
