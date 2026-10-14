import { contextBridge, ipcRenderer } from 'electron'
import type { HomeBridge } from './home-api'

const bridge: HomeBridge = {
  status: () => ipcRenderer.invoke('home:status'),
  openServer: (origin: string) => ipcRenderer.invoke('home:open-server', origin),
  forgetServer: (origin: string) => ipcRenderer.invoke('home:forget-server', origin),
  checkUpdates: () => ipcRenderer.invoke('home:updates'),
}
contextBridge.exposeInMainWorld('outpostHome', Object.freeze(bridge))
