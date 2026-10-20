import { contextBridge, ipcRenderer } from 'electron'
import type { SessionFinderBridge } from './session-finder-api'

const bridge: SessionFinderBridge = {
  state: () => ipcRenderer.invoke('session-finder:state'),
  onState: listener => {
    const handle = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state)
    ipcRenderer.on('session-finder:state', handle)
    return () => ipcRenderer.removeListener('session-finder:state', handle)
  },
  choose: id => ipcRenderer.send('session-finder:choose', id),
  create: () => ipcRenderer.send('session-finder:create'),
  refresh: () => ipcRenderer.send('session-finder:refresh'),
  cancel: () => ipcRenderer.send('session-finder:choose', null),
}
contextBridge.exposeInMainWorld('outpostSessionFinder', Object.freeze(bridge))
