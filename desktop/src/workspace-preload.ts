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
  openOutpostTerminal: server => invoke('openOutpostTerminal', server),
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
  activateTab: (id, focusTerminal) => invoke('activateTab', id, focusTerminal),
  activatePane: (id, focusTerminal) => invoke('activatePane', id, focusTerminal),
  closePane: id => invoke('closePane', id),
  paneMenu: id => invoke('paneMenu', id),
  zoomPane: id => invoke('zoomPane', id),
  closeTab: id => invoke('closeTab', id),
  renameTab: (id, label) => invoke('renameTab', id, label),
  panel: panel => invoke('panel', panel),
  movePaneBeside: (id, anchor) => invoke('movePaneBeside', id, anchor),
  splitPane: (id, direction) => invoke('splitPane', id, direction),
  resizeSplit: (id, ratio) => invoke('resizeSplit', id, ratio),
  tabMenu: id => invoke('tabMenu', id),
  reloadPane: id => invoke('reloadPane', id),
  openServer: origin => invoke('openServer', origin),
  loginServer: origin => invoke('loginServer', origin),
  cancelServerLogin: origin => invoke('cancelServerLogin', origin),
  logoutServer: origin => invoke('logoutServer', origin),
  refreshServers: () => invoke('refreshServers'),
  openRecent: id => invoke('openRecent', id),
  removeRecent: id => invoke('removeRecent', id),
  clearRecent: () => invoke('clearRecent'),
  preferences: (value, shell) => invoke('preferences', value, shell),
  checkUpdates: () => invoke('checkUpdates'),
  reportError: message => invoke('reportError', message),
}
contextBridge.exposeInMainWorld('outpostWorkspace', Object.freeze(bridge))
