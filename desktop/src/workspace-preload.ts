import { contextBridge, ipcRenderer } from 'electron'
import type { WorkspaceBridge, WorkspaceCommands, WorkspaceSnapshot } from './workspace-api'

function invoke<Name extends keyof WorkspaceCommands>(
  name: Name,
  ...args: Parameters<WorkspaceCommands[Name]>
): ReturnType<WorkspaceCommands[Name]> {
  return ipcRenderer.invoke('workspace:action', name, ...args) as ReturnType<WorkspaceCommands[Name]>
}

const bridge: WorkspaceBridge = {
  newLocal: profile => invoke('newLocal', profile),
  shellMenu: () => invoke('shellMenu'),
  tabGeometry: value => invoke('tabGeometry', value),
  dragStart: id => invoke('dragStart', id),
  dragEnd: cancel => invoke('dragEnd', cancel),
  state: () => invoke('state'),
  onState: listener => {
    const handle = (_event: Electron.IpcRendererEvent, state: WorkspaceSnapshot) => listener(state)
    ipcRenderer.on('workspace:state', handle)
    return () => {
      ipcRenderer.removeListener('workspace:state', handle)
    }
  },
  activate: (id, focusTerminal) => invoke('activate', id, focusTerminal),
  close: id => invoke('close', id),
  reorder: (id, before) => invoke('reorder', id, before),
  rename: (id, label) => invoke('rename', id, label),
  panel: panel => invoke('panel', panel),
  pair: id => invoke('pair', id),
  split: direction => invoke('split', direction),
  ratio: ratio => invoke('ratio', ratio),
  contextMenu: id => invoke('contextMenu', id),
  reload: id => invoke('reload', id),
  openServer: origin => invoke('openServer', origin),
  forgetServer: origin => invoke('forgetServer', origin),
  openRecent: id => invoke('openRecent', id),
  removeRecent: id => invoke('removeRecent', id),
  clearRecent: () => invoke('clearRecent'),
  preferences: (value, shell) => invoke('preferences', value, shell),
  checkUpdates: () => invoke('checkUpdates'),
  reportError: message => invoke('reportError', message),
}
contextBridge.exposeInMainWorld('outpostWorkspace', Object.freeze(bridge))
