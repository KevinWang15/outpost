import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Ajv } from 'ajv'
import { directoryQuery, sessionInput } from '../../shared/schemas'
import type { SessionInput } from '../../shared/model'
import { validDesktopId, type DesktopSessionReference } from '../../shared/desktopAuth'
import type { SessionCreationSelection, SessionCreatorSetup } from './session-creator-api'
import type { SessionCreationServer } from './server-session-creation'

const ajv = new Ajv({ strict: false, coerceTypes: false, removeAdditional: false, useDefaults: false })
const validInput = ajv.compile<SessionInput>(sessionInput)
const validDirectory = ajv.compile<{ path: string }>(directoryQuery)
interface Creation {
  window: BrowserWindow
  setup: SessionCreatorSetup
  servers: Map<string, SessionCreationServer>
  reads: Map<string, AbortController>
  submitting: boolean
  validateDestination(): void
  finish(result: DesktopSessionReference | null, error?: Error): void
}

/** A shared native modal returns a session identity; its caller owns placement.
 * Read work is cancellable. An explicit Create is one durable, non-retried mutation. */
export class SessionCreator {
  private current: Creation | null = null
  private submissions = new Set<Promise<void>>()
  private page: string
  constructor(private directory: string) {
    this.page = pathToFileURL(join(directory, 'session-creator/index.html')).href
    ipcMain.handle('session-creator:setup', event => this.sender(event).setup)
    ipcMain.handle('session-creator:targets', (event, origin: unknown) => {
      const current = this.sender(event)
      this.abortReads(current)
      const server = this.server(current, origin)
      return this.read(current, 'targets', signal => server.targets(signal))
    })
    ipcMain.handle('session-creator:options', (event, value: unknown) => {
      const current = this.sender(event)
      current.reads.get('directories')?.abort()
      const { server, targetId } = this.selection(current, value)
      return this.read(current, 'options', signal => server.options(targetId, signal))
    })
    ipcMain.handle('session-creator:directories', (event, value: unknown, path: unknown) => {
      const current = this.sender(event)
      const { server, targetId } = this.selection(current, value)
      const query = { path }
      if (!validDirectory(query)) throw new Error('Enter an absolute or ~/ directory path.')
      return this.read(current, 'directories', signal => server.directories(targetId, query.path, signal))
    })
    ipcMain.handle('session-creator:create', (event, value: unknown, input: unknown) => {
      const current = this.sender(event)
      if (current.submitting) throw new Error('Session creation is already in progress.')
      if (!validInput(input)) throw new Error('Check the session name, directory, tool, arguments and environment.')
      const { server, targetId } = this.selection(current, value)
      current.validateDestination()
      current.submitting = true
      this.abortReads(current)
      const work = server
        .create(targetId, input)
        .then(session => {
          if (this.current === current) current.finish(session)
        })
        .finally(() => {
          current.submitting = false
          this.submissions.delete(work)
        })
      this.submissions.add(work)
      return work
    })
    ipcMain.on('session-creator:cancel', event => {
      const current = this.authorizedSender(event)
      if (current && !current.submitting) current.finish(null)
    })
  }
  private authorizedSender(event: IpcMainEvent | IpcMainInvokeEvent) {
    const current = this.current
    if (
      !current ||
      current.window.isDestroyed() ||
      event.sender !== current.window.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      event.senderFrame?.url !== this.page
    )
      return null
    return current
  }
  private sender(event: IpcMainEvent | IpcMainInvokeEvent) {
    const current = this.authorizedSender(event)
    if (!current) throw new Error('This action is only available in the session creation dialog.')
    return current
  }
  private server(current: Creation, origin: unknown) {
    const server = typeof origin === 'string' ? current.servers.get(origin) : undefined
    if (!server) throw new Error('Choose a logged-in Outpost server.')
    return server
  }
  private selection(current: Creation, value: unknown) {
    const selection = value as SessionCreationSelection
    if (!selection || !validDesktopId(selection.targetId)) throw new Error('Choose an execution target.')
    return { server: this.server(current, selection.server), targetId: selection.targetId }
  }
  private abortReads(current: Creation) {
    for (const controller of current.reads.values()) controller.abort()
    current.reads.clear()
  }
  private async read<T>(current: Creation, key: string, work: (signal: AbortSignal) => Promise<T>) {
    if (current.submitting) throw new Error('Session creation is in progress.')
    current.reads.get(key)?.abort()
    const controller = new AbortController()
    current.reads.set(key, controller)
    try {
      const result = await work(controller.signal)
      controller.signal.throwIfAborted()
      return result
    } finally {
      if (current.reads.get(key) === controller) current.reads.delete(key)
    }
  }
  pick(
    parent: BrowserWindow,
    servers: SessionCreationServer[],
    defaults: SessionCreatorSetup['defaults'],
    validateDestination: () => void,
  ) {
    if (this.current) {
      this.current.window.show()
      this.current.window.focus()
      return Promise.resolve(null)
    }
    if (parent.isDestroyed()) return Promise.resolve(null)
    const area = screen.getDisplayMatching(parent.getBounds()).workArea
    const window = new BrowserWindow({
      parent,
      modal: true,
      title: 'New Outpost session',
      width: Math.min(640, area.width),
      height: Math.min(760, area.height),
      minWidth: Math.min(460, area.width),
      minHeight: Math.min(360, area.height),
      show: false,
      frame: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      backgroundColor: '#0f172a',
      webPreferences: {
        preload: join(this.directory, 'session-creator-preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    window.setMenu(null)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    return new Promise<DesktopSessionReference | null>((resolve, reject) => {
      let settled = false
      const finish = (result: DesktopSessionReference | null, error?: Error) => {
        if (settled) return
        settled = true
        this.abortReads(current)
        parent.removeListener('closed', closed)
        if (this.current === current) this.current = null
        if (!window.isDestroyed()) window.destroy()
        if (error) reject(error)
        else resolve(result)
      }
      const current: Creation = {
        window,
        setup: { servers: servers.map(server => server.summary), defaults },
        servers: new Map(servers.map(server => [server.summary.origin, server])),
        reads: new Map(),
        submitting: false,
        validateDestination,
        finish,
      }
      const closed = () => finish(null)
      this.current = current
      parent.once('closed', closed)
      window.on('closed', closed)
      window.on('close', event => {
        if (current.submitting) event.preventDefault()
      })
      window.webContents.on('render-process-gone', () =>
        finish(null, new Error('The session creation dialog stopped responding.')),
      )
      window.webContents.on('before-input-event', (event, input) => {
        if (
          input.type === 'keyDown' &&
          !input.isComposing &&
          (input.meta || input.control) &&
          input.key.toLowerCase() === 'w'
        ) {
          event.preventDefault()
          if (!current.submitting) finish(null)
        }
      })
      window.once('ready-to-show', () => {
        if (!settled) {
          window.show()
          window.focus()
        }
      })
      void window.loadURL(this.page).catch(error => finish(null, error))
    })
  }
  cancel() {
    this.current?.finish(null)
  }
  async flush() {
    await Promise.allSettled(this.submissions)
  }
  get focused() {
    return !!this.current && !this.current.window.isDestroyed() && this.current.window.isFocused()
  }
  edit(action: 'copy' | 'paste' | 'select-all') {
    const window = this.current?.window
    if (!window || !this.focused) return false
    if (action === 'select-all') window.webContents.selectAll()
    else window.webContents[action]()
    return true
  }
}
