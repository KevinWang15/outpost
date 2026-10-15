import { contextBridge, ipcRenderer } from 'electron'
import type { WorkspaceBridge, WorkspaceSnapshot } from './workspace-api'

const bridge: WorkspaceBridge = {
  tabGeometry: value => ipcRenderer.invoke('workspace:action', 'tab-geometry', value),
  dragStart: id => ipcRenderer.invoke('workspace:action', 'drag-start', id),
  dragEnd: cancel => ipcRenderer.invoke('workspace:action', 'drag-end', cancel),
  state: () => ipcRenderer.invoke('workspace:action', 'state'),
  onState: listener => {
    const handle = (_event: Electron.IpcRendererEvent, state: WorkspaceSnapshot) => listener(state)
    ipcRenderer.on('workspace:state', handle)
    return () => {
      ipcRenderer.removeListener('workspace:state', handle)
    }
  },
  activate: id => ipcRenderer.invoke('workspace:action', 'activate', id),
  close: id => ipcRenderer.invoke('workspace:action', 'close', id),
  reorder: (id, before) => ipcRenderer.invoke('workspace:action', 'reorder', id, before),
  rename: (id, label) => ipcRenderer.invoke('workspace:action', 'rename', id, label),
  panel: panel => ipcRenderer.invoke('workspace:action', 'panel', panel),
  pair: id => ipcRenderer.invoke('workspace:action', 'pair', id),
  split: direction => ipcRenderer.invoke('workspace:action', 'split', direction),
  ratio: ratio => ipcRenderer.invoke('workspace:action', 'ratio', ratio),
  contextMenu: id => ipcRenderer.invoke('workspace:action', 'context-menu', id),
  reload: id => ipcRenderer.invoke('workspace:action', 'reload', id),
  openServer: origin => ipcRenderer.invoke('workspace:action', 'open-server', origin),
  forgetServer: origin => ipcRenderer.invoke('workspace:action', 'forget-server', origin),
  preferences: value => ipcRenderer.invoke('workspace:action', 'preferences', value),
  checkUpdates: () => ipcRenderer.invoke('workspace:action', 'updates'),
  reportError: message => ipcRenderer.invoke('workspace:action', 'report-error', message),
}
contextBridge.exposeInMainWorld('outpostWorkspace', Object.freeze(bridge))
