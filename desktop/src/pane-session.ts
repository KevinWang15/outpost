import { writeFile } from 'node:fs/promises'
import WebSocketClient from 'ws'
import { desktopSessionId, type DesktopLaunch, type DesktopSessionReference } from '../../shared/desktopAuth'
import type { HarnessId } from '../../shared/harnesses'
import { SessionFileCache } from '../../shared/sessionFileCache'
import { parseSessionFile, previewImage } from '../../shared/sessionFiles'
import { browserUrl } from '../../shared/signals'
import { TerminalActivity } from '../../shared/terminal/activity'
import { TerminalSocket } from '../../shared/terminal/socket'
import { terminalSize, type Scrollback } from '../../shared/terminalService'
import { errorMessage, type Emit, type PaneCommand } from './helper-protocol'
import { NativeRendering } from './native-rendering'

interface Attachment {
  key: string
  launch: DesktopLaunch
  socket: TerminalSocket
  rendering: NativeRendering
  files: SessionFileCache
  activity: TerminalActivity
  focused: boolean
  size?: { cols: number; rows: number }
}

export interface PaneHost {
  emit: Emit
  nextId(): number
  closing(): boolean
  ownsSession(ref: DesktopSessionReference): boolean
  scrollback(): Scrollback
  knownTool(sessionKey: string): HarnessId | undefined
  rememberSession(entry: {
    server: string
    accountId: string
    targetId: string
    sessionId: string
    id: string
    title: string
    tool: HarnessId
    lastConnectedAt: number
  }): void
}

/** Owns live remote terminal panes attached to GPUI windows. */
export class PaneRegistry {
  private panes = new Map<number, Attachment>()

  constructor(private host: PaneHost) {}

  setScrollback(scrollback: Scrollback) {
    for (const pane of this.panes.values()) pane.socket.setScrollback(scrollback)
  }

  closeAll() {
    for (const [id, pane] of this.panes) this.closePane(id, pane)
  }

  removeAccount(keep: (ref: DesktopSessionReference) => boolean) {
    for (const [id, pane] of this.panes) {
      if (keep(pane.launch)) continue
      this.closePane(id, pane)
      this.host.emit('paneRemoved', { pane: id })
    }
  }

  private closePane(id: number, pane: Attachment) {
    this.panes.delete(id)
    pane.activity.dispose()
    pane.socket.close()
    pane.rendering.dispose()
    pane.files.clear()
  }

  async attach(launch: DesktopLaunch, window?: number) {
    if (this.host.closing() || !this.host.ownsSession(launch)) return
    const key = desktopSessionId(launch)
    for (const [pane, existing] of this.panes)
      if (existing.key === key) {
        if (existing.launch.loginId === launch.loginId) await existing.socket.activate(launch.token)
        else {
          existing.launch = launch
          existing.socket.reconnect(launch.token)
        }
        if (this.panes.get(pane) === existing) this.host.emit('select', { pane })
        return
      }
    const pane = this.host.nextId()
    const rendering = new NativeRendering(
      pane,
      this.host.emit,
      () => this.host.nextId(),
      reason => state.socket.fail(reason),
    )
    const socket = new TerminalSocket(
      launch.token,
      () => state.size,
      rendering,
      {
        state: connection => {
          state.activity.setActive(state.focused && connection.kind === 'connected')
          this.host.emit('connection', { pane, state: connection })
        },
        hello: msg => {
          this.host.emit('session', { pane, title: msg.session.name, tool: msg.session.tool })
          this.host.rememberSession({
            server: launch.server,
            accountId: launch.accountId,
            targetId: launch.targetId,
            sessionId: launch.sessionId,
            id: key,
            title: msg.session.name,
            tool: msg.session.tool,
            lastConnectedAt: Date.now(),
          })
        },
        signal: s => {
          if (s.signal.type === 'files.changed') this.host.emit('filesChanged', { pane })
          if (s.signal.type === 'browser.open') {
            try {
              this.host.emit('browser', { url: browserUrl(s.signal.payload) })
            } catch (error) {
              this.host.emit('error', { pane, message: errorMessage(error) })
            }
          }
        },
        activity: activity => {
          if (!activity) {
            state.activity.update(null)
            this.host.emit('activity', { pane, activity })
            return
          }
          // Apply the observation only once the native pane has received this exact activity.
          rendering.barrier(() => state.activity.update(activity), 'activity', { activity })
        },
        deliveries: waiting => this.host.emit('deliveries', { pane, waiting }),
      },
      {
        origin: launch.server,
        open: url =>
          new WebSocketClient(url, {
            origin: launch.server,
            followRedirects: false,
            maxPayload: 8 * 1024 * 1024,
          }) as unknown as WebSocket,
      },
    )
    const state: Attachment = {
      key,
      launch,
      socket,
      files: new SessionFileCache((file, signal) =>
        socket.readFile(file, signal, received => this.host.emit('fileProgress', { pane, id: file.id, received })),
      ),
      rendering,
      focused: false,
      activity: new TerminalActivity(socket, message => this.host.emit('error', { pane, message })),
    }
    this.panes.set(pane, state)
    this.host.emit('opened', {
      pane,
      window,
      title: launch.title,
      server: launch.server,
      tool: this.host.knownTool(key),
      sessionKey: key,
    })
    state.socket.setScrollback(this.host.scrollback())
    state.socket.open()
  }

  async handle(c: PaneCommand): Promise<void> {
    const p = this.panes.get(c.pane)
    if (!p) return
    switch (c.op) {
      case 'ack':
        return p.rendering.ack(c.seq)
      case 'input':
        p.socket.input(Buffer.from(c.data, 'base64'))
        return
      case 'resize':
        if (terminalSize(c.cols, c.rows)) {
          p.size = { cols: c.cols, rows: c.rows }
          p.socket.resize(c.cols, c.rows)
        }
        return
      case 'focus':
        p.focused = c.active
        p.socket.setActive(c.active)
        return p.activity.setActive(c.active && p.socket.connected)
      case 'observe':
        return p.activity.acknowledge()
      case 'resume':
        return p.socket.resume()
      case 'reconnect':
        return p.socket.reconnect()
      case 'close':
        this.closePane(c.pane, p)
        return
      case 'draft':
        return p.socket.draft(c.active)
      case 'submit':
        await p.socket.submit(c.text)
        this.host.emit('submitted', { pane: c.pane, text: c.text })
        return
      case 'clear':
        return p.socket.clear()
      case 'deliver':
        return p.socket.deliverNow()
      case 'image': {
        const pasted = await p.socket.pasteImage(
          new File([Buffer.from(c.data, 'base64')], 'clipboard', { type: c.mime }),
          c.mode,
        )
        this.host.emit('notice', { pane: c.pane, message: pasted === 'path' ? 'Image path pasted' : 'Image attached' })
        return
      }
      case 'files': {
        const files = await p.socket.listFiles(AbortSignal.timeout(20000))
        p.files.retain(files)
        this.host.emit('files', { pane: c.pane, files })
        return
      }
      case 'preview': {
        const file = parseSessionFile(c.file)
        try {
          if (!previewImage(file)) throw new Error('Preview not supported.')
          const blob = await p.files.read(file)
          if (this.panes.get(c.pane) === p)
            this.host.emit('preview', {
              pane: c.pane,
              id: file.id,
              mime: file.mediaType,
              data: Buffer.from(await blob.arrayBuffer()).toString('base64'),
            })
        } catch (error) {
          if (this.panes.get(c.pane) === p)
            this.host.emit('previewFailed', { pane: c.pane, id: file.id, message: errorMessage(error) })
        }
        return
      }
      case 'saveFile': {
        const file = parseSessionFile(c.file)
        const blob = await p.files.read(file)
        await writeFile(c.path, Buffer.from(await blob.arrayBuffer()))
        this.host.emit('fileSaved', { pane: c.pane, path: c.path })
        return
      }
      case 'deleteFile': {
        const file = parseSessionFile(c.file)
        await p.socket.removeFile(file.id, AbortSignal.timeout(120000))
        p.files.remove(file.id)
        return this.handle({ op: 'files', pane: c.pane })
      }
    }
  }
}
