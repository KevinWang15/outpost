import { contextBridge, ipcRenderer } from 'electron'
import type { SessionCreatorBridge } from '../../shared/sessionCreator'

const bridge: SessionCreatorBridge = {
  setup: () => ipcRenderer.invoke('session-creator:setup'),
  targets: server => ipcRenderer.invoke('session-creator:targets', server),
  options: selection => ipcRenderer.invoke('session-creator:options', selection),
  directories: (selection, path) => ipcRenderer.invoke('session-creator:directories', selection, path),
  create: (selection, input) => ipcRenderer.invoke('session-creator:create', selection, input),
  cancel: () => ipcRenderer.send('session-creator:cancel'),
}
contextBridge.exposeInMainWorld('outpostSessionCreator', Object.freeze(bridge))
