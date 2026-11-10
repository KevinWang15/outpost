import { contextBridge, ipcRenderer } from 'electron'
import { chatBridgeVersion, type ChatBridge } from '../../shared/chatBridge'

const bridge: ChatBridge = {
  version: chatBridgeVersion,
  ticket: () => ipcRenderer.invoke('chat:ticket'),
  openLink: url => void ipcRenderer.invoke('chat:open-link', url),
  openTerminal: (targetId, sessionId) => ipcRenderer.invoke('chat:open-terminal', targetId, sessionId),
}
contextBridge.exposeInMainWorld('outpostChat', bridge)
