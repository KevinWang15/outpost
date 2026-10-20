import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent, type Point } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tabBarHeight } from './layout'
import type { DesktopSessionChoice } from '../../shared/desktopAuth'
import { SessionFinderFlow, type SessionFinderActions } from './session-finder-flow'

/** One reusable native popover, above terminal views without hiding or resizing them. */
export class SessionFinder {
  private current: {
    window: BrowserWindow
    flow: SessionFinderFlow
  } | null = null

  constructor(private directory: string) {
    ipcMain.handle('session-finder:state', event => {
      const current = this.sender(event)
      if (!current) throw new Error('This action is only available in the session finder.')
      return current.flow.state
    })
    ipcMain.on('session-finder:choose', (event, id: unknown) => {
      const current = this.sender(event)
      if (id === null) current?.flow.finish()
      else if (typeof id === 'string') void current?.flow.choose(id)
    })
    ipcMain.on('session-finder:create', event => {
      void this.sender(event)?.flow.create()
    })
    ipcMain.on('session-finder:refresh', event => {
      void this.sender(event)?.flow.refresh()
    })
  }

  private sender(event: IpcMainEvent | IpcMainInvokeEvent) {
    const current = this.current
    return current &&
      !current.window.isDestroyed() &&
      event.sender === current.window.webContents &&
      event.senderFrame === event.sender.mainFrame &&
      event.senderFrame?.url === pathToFileURL(join(this.directory, 'session-finder.html')).href
      ? current
      : null
  }

  pick(
    parent: BrowserWindow,
    title: string,
    anchor: Point,
    actions: Omit<SessionFinderActions, 'create'> & {
      create(parent: BrowserWindow): Promise<DesktopSessionChoice | null>
    },
  ): Promise<void> {
    this.current?.flow.finish()
    if (parent.isDestroyed()) return Promise.resolve()
    const area = screen.getDisplayMatching(parent.getBounds()).workArea
    const width = Math.min(460, area.width),
      height = Math.min(416, area.height)
    const window = new BrowserWindow({
      parent,
      width,
      height,
      x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, anchor.x - 16))),
      y: Math.round(
        Math.max(area.y, Math.min(area.y + area.height - height, parent.getContentBounds().y + tabBarHeight + 6)),
      ),
      title,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      backgroundColor: '#101a2b',
      webPreferences: {
        preload: join(this.directory, 'session-finder-preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    window.setMenu(null)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    return new Promise((resolve, reject) => {
      const flow = new SessionFinderFlow(title, {
        ...actions,
        // A modal child of the picker returns native focus to the picker. The
        // terminal only regains focus when the entire interaction finishes.
        create: () => actions.create(window),
        changed: state => {
          if (!window.webContents.isDestroyed()) window.webContents.send('session-finder:state', state)
        },
        finished: error => {
          parent.removeListener('closed', cancel)
          parent.removeListener('hide', cancel)
          parent.removeListener('minimize', cancel)
          if (this.current?.window === window) this.current = null
          if (!window.isDestroyed()) window.destroy()
          if (error) reject(error)
          else resolve()
        },
      })
      const cancel = () => flow.finish()
      this.current = { window, flow }
      parent.once('closed', cancel)
      parent.once('hide', cancel)
      parent.once('minimize', cancel)
      window.on('closed', cancel)
      window.on('blur', () => {
        if (flow.state.busy === 'idle') cancel()
      })
      window.webContents.on('render-process-gone', () =>
        flow.finish(new Error('The session finder stopped responding. Please try again.')),
      )
      window.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || input.isComposing) return
        if (input.key === 'Escape' || ((input.meta || input.control) && input.key.toLowerCase() === 'w')) {
          event.preventDefault()
          cancel()
        }
      })
      window.once('ready-to-show', () => {
        if (this.current?.window !== window) return
        window.show()
        window.focus()
        window.webContents.focus()
      })
      void window.loadFile(join(this.directory, 'session-finder.html')).catch(error => flow.finish(error))
      void flow.refresh()
    })
  }
  cancel() {
    this.current?.flow.finish()
  }
  edit(action: 'copy' | 'paste' | 'select-all') {
    const window = this.current?.window
    if (!window || window.isDestroyed() || !window.isFocused()) return false
    if (action === 'select-all') window.webContents.selectAll()
    else window.webContents[action]()
    return true
  }
}
