import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sessionFileId } from '../../shared/sessionFiles'
import type { NativeSessionFiles } from './session-files'

interface Viewer {
  window: BrowserWindow
  files: NativeSessionFiles
  selected: string
  done: Promise<void>
  finish(error?: Error): void
}

/** A separate native modal covers all split panes without changing any PTY size.
 * Only its isolated local page can use the originating pane's file capability. */
export class SessionFileViewer {
  private viewers = new Map<number, Viewer>()
  private page: string
  constructor(private directory: string) {
    this.page = pathToFileURL(join(directory, 'file-viewer/index.html')).href
    ipcMain.handle('file-viewer:selection', event => this.sender(event).selected)
    ipcMain.handle('file-viewer:list', event => this.sender(event).files.list())
    ipcMain.handle('file-viewer:read', async (event, value: unknown) =>
      (await this.sender(event).files.read(value)).arrayBuffer(),
    )
    ipcMain.handle('file-viewer:remove', (event, id: unknown) => {
      const viewer = this.sender(event)
      if (!viewer.window.isFocused()) throw new Error('Focus the file viewer first.')
      return viewer.files.remove(id)
    })
    ipcMain.handle('file-viewer:download', (event, value: unknown) => {
      const viewer = this.sender(event)
      if (!viewer.window.isFocused()) return false
      return viewer.files.save(viewer.window, viewer.window.webContents, value)
    })
    ipcMain.on('file-viewer:close', event => {
      if (this.viewers.has(event.sender.id)) this.sender(event).finish()
    })
  }
  private sender(event: IpcMainEvent | IpcMainInvokeEvent) {
    const viewer = this.viewers.get(event.sender.id)
    if (
      !viewer ||
      viewer.window.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame?.url !== this.page
    )
      throw new Error('File viewer access is unavailable in this page.')
    return viewer
  }
  open(parent: BrowserWindow, owner: WebContents, files: NativeSessionFiles, selected: unknown) {
    if (!sessionFileId(selected)) throw new Error('Invalid session file ID.')
    for (const viewer of this.viewers.values()) {
      if (viewer.window.getParentWindow() === parent) {
        viewer.window.focus()
        return viewer.done
      }
    }
    const window = new BrowserWindow({
      ...parent.getBounds(),
      parent,
      // macOS turns modal:true into a sheet and controls its placement. Keep a
      // full-window child and disable its parent explicitly on every platform.
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      backgroundColor: '#0f172a',
      title: 'Session files · Outpost',
      webPreferences: {
        preload: join(this.directory, 'file-viewer-preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    window.setMenu(null)
    const viewerId = window.webContents.id
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    let resolve!: () => void
    let reject!: (error: Error) => void
    const done = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    let settled = false
    let disabledParent = false
    const syncBounds = () => {
      if (!window.isDestroyed() && !parent.isDestroyed()) window.setBounds(parent.getBounds())
    }
    const closed = () => finish()
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      const focused = !window.isDestroyed() && window.isFocused()
      this.viewers.delete(viewerId)
      owner.removeListener('destroyed', closed)
      owner.removeListener('render-process-gone', closed)
      owner.removeListener('did-start-navigation', navigated)
      parent.removeListener('closed', closed)
      parent.removeListener('resize', syncBounds)
      parent.removeListener('move', syncBounds)
      if (disabledParent && !parent.isDestroyed()) parent.setEnabled(true)
      if (!window.isDestroyed()) window.destroy()
      if (focused && !parent.isDestroyed()) parent.focus()
      if (error) reject(error)
      else resolve()
    }
    const navigated = (_event: Electron.Event, _url: string, inPlace: boolean, main: boolean) => {
      if (main && !inPlace) finish()
    }
    this.viewers.set(viewerId, { window, files, selected, done, finish })
    owner.once('destroyed', closed)
    owner.once('render-process-gone', closed)
    owner.on('did-start-navigation', navigated)
    parent.once('closed', closed)
    parent.on('resize', syncBounds)
    parent.on('move', syncBounds)
    window.on('closed', closed)
    window.on('close', event => {
      event.preventDefault()
      finish()
    })
    window.webContents.on('render-process-gone', () =>
      finish(new Error('The file viewer stopped responding. Open it again to retry.')),
    )
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isComposing) return
      if (
        (input.key === 'Escape' && !input.meta && !input.control && !input.alt) ||
        ((input.meta || input.control) && input.key.toLowerCase() === 'w')
      ) {
        event.preventDefault()
        finish()
      }
    })
    window.once('ready-to-show', () => {
      if (!settled) {
        syncBounds()
        if (parent.isEnabled()) {
          parent.setEnabled(false)
          disabledParent = true
        }
        window.show()
        window.focus()
      }
    })
    void window.loadURL(this.page).catch(error => finish(error))
    return done
  }
}
