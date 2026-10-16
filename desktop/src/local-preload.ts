import './preload'
import { contextBridge, ipcRenderer } from 'electron'
import type { LocalTerminalBridge, LocalTerminalEvent } from '../../shared/localTerminal'

const bridge: LocalTerminalBridge = {
  onEvent: listener => {
    const handle = (_event: Electron.IpcRendererEvent, value: LocalTerminalEvent) => listener(value)
    ipcRenderer.on('local:event', handle)
    return () => {
      ipcRenderer.removeListener('local:event', handle)
    }
  },
  start: (generation, cols, rows) => ipcRenderer.invoke('local:start', generation, cols, rows),
  write: (generation, data) => ipcRenderer.invoke('local:write', generation, data),
  resize: (generation, cols, rows) => ipcRenderer.invoke('local:resize', generation, cols, rows),
  acknowledge: (generation, length) => ipcRenderer.send('local:ack', generation, length),
  stop: generation => ipcRenderer.invoke('local:stop', generation),
  pasteImage: (generation, data, mediaType) => ipcRenderer.invoke('local:image', generation, data, mediaType),
}
contextBridge.exposeInMainWorld('outpostLocalTerminal', Object.freeze(bridge))
