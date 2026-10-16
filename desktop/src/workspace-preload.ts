import { contextBridge, ipcRenderer } from 'electron'
import type { WorkspaceBridge, WorkspaceSnapshot } from './workspace-api'

const bridge: WorkspaceBridge = {
  newLocal: profile => ipcRenderer.invoke('workspace:action', 'new-local', profile),
  shellMenu: () => ipcRenderer.invoke('workspace:action', 'shell-menu'),
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
  activate: (id, focusTerminal) => ipcRenderer.invoke('workspace:action', 'activate', id, focusTerminal),
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
  openRecent: id => ipcRenderer.invoke('workspace:action', 'open-recent', id),
  removeRecent: id => ipcRenderer.invoke('workspace:action', 'remove-recent', id),
  clearRecent: () => ipcRenderer.invoke('workspace:action', 'clear-recent'),
  preferences: (value, shell) => ipcRenderer.invoke('workspace:action', 'preferences', value, shell),
  checkUpdates: () => ipcRenderer.invoke('workspace:action', 'updates'),
  reportError: message => ipcRenderer.invoke('workspace:action', 'report-error', message),
}
contextBridge.exposeInMainWorld('outpostWorkspace', Object.freeze(bridge))
