import { contextBridge, ipcRenderer } from 'electron'
import type { FileViewerBridge } from '../../shared/sessionFiles'

const bridge: FileViewerBridge = {
  selection: () => ipcRenderer.invoke('file-viewer:selection'),
  list: () => ipcRenderer.invoke('file-viewer:list'),
  read: file => ipcRenderer.invoke('file-viewer:read', file),
  remove: id =>
    navigator.userActivation.isActive
      ? ipcRenderer.invoke('file-viewer:remove', id)
      : Promise.reject(new Error('Click Remove to delete a file.')),
  download: file =>
    navigator.userActivation.isActive ? ipcRenderer.invoke('file-viewer:download', file) : Promise.resolve(false),
  close: () => ipcRenderer.send('file-viewer:close'),
}
contextBridge.exposeInMainWorld('outpostFileViewer', Object.freeze(bridge))
