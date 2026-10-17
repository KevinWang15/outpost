import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent, type Point } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tabBarHeight } from './layout'
import type { SessionFinderState } from './session-finder-api'
import { desktopSessionId, type DesktopSessionChoice, type DesktopSessionReference } from '../../shared/desktopAuth'

type Catalogue = Pick<SessionFinderState, 'sessions' | 'errors'>
type FinderUpdate = Partial<Catalogue> & Pick<SessionFinderState, 'focusId'> & { loading?: boolean }
type LoadSessions = (signal: AbortSignal, publish: (catalogue: Catalogue) => void) => Promise<void>
type CreateSession = () => Promise<DesktopSessionReference | null>

/** One reusable native popover, above terminal views without hiding or resizing them. */
export class SessionFinder {
  private current: {
    window: BrowserWindow
    state: SessionFinderState
    finish(id: string | null, error?: Error): void
    create: CreateSession
    refresh(focusId?: string): void
    creating: boolean
  } | null = null

  constructor(private directory: string) {
    ipcMain.handle('session-finder:state', event => {
      const current = this.sender(event)
      if (!current) throw new Error('This action is only available in the session finder.')
      return current.state
    })
    ipcMain.on('session-finder:choose', (event, id: unknown) => {
      const current = this.sender(event)
      if (!current) return
      if (id === null || (typeof id === 'string' && current.state.sessions.some(session => session.id === id)))
        current.finish(id)
    })
    ipcMain.on('session-finder:create', event => {
      const current = this.sender(event)
      if (!current || current.creating) return
      current.creating = true
      current.window.hide()
      void current
        .create()
        .then(reference => {
          if (this.current !== current) return
          current.creating = false
          if (reference) current.refresh(desktopSessionId(reference))
          if (!current.window.isDestroyed()) {
            current.window.show()
            current.window.focus()
            current.window.webContents.focus()
          }
        })
        .catch(error => current.finish(null, error instanceof Error ? error : new Error(String(error))))
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
    load: LoadSessions,
    create: CreateSession,
  ): Promise<DesktopSessionChoice | null> {
    this.current?.finish(null)
    if (parent.isDestroyed()) return Promise.resolve(null)
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
      let settled = false
      let abort = new AbortController()
      let state: SessionFinderState = { title, revision: 0, sessions: [], errors: [], loading: true }
      const update = (next: FinderUpdate) => {
        if (settled) return
        state = { ...state, ...next, revision: state.revision + 1 }
        if (this.current?.window === window) this.current.state = state
        if (!window.webContents.isDestroyed()) window.webContents.send('session-finder:state', state)
      }
      const refresh = (focusId?: string) => {
        if (settled) return
        abort.abort()
        const controller = new AbortController()
        abort = controller
        update({ loading: true, ...(focusId ? { focusId } : {}) })
        const publish = (catalogue: Catalogue) => {
          if (abort === controller && !controller.signal.aborted) update(catalogue)
        }
        void load(controller.signal, publish)
          .then(() => {
            if (abort === controller && !controller.signal.aborted)
              update({ loading: false, ...(focusId ? { focusId: undefined } : {}) })
          })
          .catch(error => {
            if (abort === controller && !controller.signal.aborted)
              update({
                loading: false,
                errors: [error instanceof Error ? error.message : 'Could not load sessions.'],
              })
          })
      }
      const finish = (id: string | null, error?: Error) => {
        if (settled) return
        settled = true
        abort.abort()
        parent.removeListener('closed', cancel)
        parent.removeListener('hide', cancel)
        parent.removeListener('minimize', cancel)
        if (this.current?.window === window) this.current = null
        if (!window.isDestroyed()) window.close()
        if (error) reject(error)
        else resolve(state.sessions.find(session => session.id === id) ?? null)
      }
      const cancel = () => finish(null)
      const current = { window, state, finish, create, refresh, creating: false }
      this.current = current
      parent.once('closed', cancel)
      parent.once('hide', cancel)
      parent.once('minimize', cancel)
      window.on('closed', cancel)
      window.on('blur', () => {
        if (!current.creating) cancel()
      })
      window.webContents.on('render-process-gone', () =>
        finish(null, new Error('The session finder stopped responding. Please try again.')),
      )
      window.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || input.isComposing) return
        if (input.key === 'Escape' || ((input.meta || input.control) && input.key.toLowerCase() === 'w')) {
          event.preventDefault()
          cancel()
        }
      })
      window.once('ready-to-show', () => {
        if (settled) return
        window.show()
        window.focus()
        window.webContents.focus()
      })
      void window.loadFile(join(this.directory, 'session-finder.html')).catch(error => finish(null, error))
      refresh()
    })
  }
  cancel() {
    this.current?.finish(null)
  }
  edit(action: 'copy' | 'paste' | 'select-all') {
    const window = this.current?.window
    if (!window || window.isDestroyed() || !window.isFocused()) return false
    if (action === 'select-all') window.webContents.selectAll()
    else window.webContents[action]()
    return true
  }
}
