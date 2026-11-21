import { terminalRouteLabels } from '../../shared/protocol'
// Child-process adapter for V3's shared protocol and account services. Stdin/stdout
// are private inherited pipes. Credentials stay here and never enter the terminal grid.
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import WebSocketClient from 'ws'
import { ServerAccounts } from './server-accounts'
import { ServerTrust } from './server-trust'
import { RecentSessions } from './recent-sessions'
import { Preferences } from './preferences'
import { shellProfiles } from './shell-profiles'
import { bufferControls, terminalControls } from './checkpoint-modes'
import type { CheckpointState } from '../../shared/terminalState'
import { TerminalActivity } from '../../frontend/terminal/activity'
import { TerminalSocket } from '../../frontend/terminal/socket'
import type { TerminalRendering } from '../../frontend/terminal/rendering'
import { CheckpointReader } from '../../shared/terminalCheckpoint'
import { terminalService, terminalSize } from '../../shared/terminalService'
import {
  desktopSessionId,
  parseDesktopConnectUrl,
  parseDesktopEntry,
  type DesktopLaunch,
  type DesktopSessionChoice,
} from '../../shared/desktopAuth'
import { browserUrl } from '../../shared/signals'
import { parseSessionFile, previewImage } from '../../shared/sessionFiles'
import type { SessionInput } from '../../shared/model'
import type { ServerMessage } from '../../shared/protocol'

const dir = process.argv[2]
let closing = false
const emit = (event: string, payload: object = {}) => {
  if (!closing) process.stdout.write(JSON.stringify({ event, ...payload }) + '\n')
}
const pending = new Set<Promise<unknown>>()
function run(work: Promise<unknown>, context: object = {}) {
  const task = work.catch(error => {
    if (closing) console.error(message(error))
    else emit('error', { ...context, message: message(error) })
  })
  pending.add(task)
  void task.finally(() => pending.delete(task))
}
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const prompts = new Map<number, (answer: boolean) => void>()
let serial = 0
const trust = new ServerTrust(
  join(dir, 'server-trust.json'),
  origin =>
    new Promise(resolve => {
      if (closing) return resolve(false)
      const id = ++serial
      prompts.set(id, resolve)
      emit('trust', { id, origin })
    }),
)
const accounts = new ServerAccounts(join(dir, 'server-logins.json'), trust, {
  openBrowser: async url => {
    emit('browser', { url })
  },
  changed: () => snapshot(),
  failed: error => emit('error', { message: error.message }),
})
const recent = new RecentSessions(join(dir, 'recent-sessions.json'))
const prefs = new Preferences(join(dir, 'preferences.json'))
const profiles = shellProfiles()
let catalogue: DesktopSessionChoice[] = []
let listing: AbortController | undefined
const snapshot = () => emit('accounts', { ...accounts.snapshot(), recent: recent.list(), sessions: catalogue })
const refresh = async () => {
  if (closing) return
  listing?.abort()
  const controller = (listing = new AbortController())
  await accounts.refresh()
  await accounts.sessions(
    controller.signal,
    data => {
      catalogue = data.sessions
      snapshot()
      if (data.errors.length) emit('error', { message: data.errors.join('\n') })
    },
    catalogue,
  )
}

class NativeRendering implements TerminalRendering {
  private scratch?: Terminal
  private reader?: CheckpointReader
  private serializer?: SerializeAddon
  private state?: CheckpointState
  private links: Record<'normal' | 'alt', number[][]> = { normal: [], alt: [] }
  private live = false
  private callbacks = new Map<number, () => void>()
  constructor(
    readonly pane: number,
    private failed: (reason: string) => void,
  ) {}
  begin() {
    this.dispose()
    this.live = false
  }
  dispose() {
    this.scratch?.dispose()
    this.scratch = undefined
    this.reader = undefined
    this.serializer = undefined
    this.callbacks.clear()
    this.state = undefined
    this.links = { normal: [], alt: [] }
  }
  barrier(done: () => void, event = 'barrier', payload: object = {}) {
    const seq = ++serial
    this.callbacks.set(seq, done)
    emit(event, { pane: this.pane, seq, ...payload })
  }
  ack(seq: number) {
    const done = this.callbacks.get(seq)
    this.callbacks.delete(seq)
    done?.()
  }
  private bytes(bytes: Uint8Array) {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let i = 0; i < buf.length; i += 65536)
      emit('output', { pane: this.pane, data: buf.subarray(i, i + 65536).toString('base64') })
  }
  output(bytes: Uint8Array, done: () => void) {
    if (!this.live) return this.failed('Live output arrived before the checkpoint.')
    this.bytes(bytes)
    this.barrier(done)
  }
  restore(msg: Extract<ServerMessage, { type: 'restore' | 'clear' | 'geometry' }>, done: () => void) {
    try {
      if (msg.type === 'geometry') {
        if (!this.live || !terminalSize(msg.cols, msg.rows)) throw new Error('Invalid terminal geometry')
        emit('geometry', { pane: this.pane, cols: msg.cols, rows: msg.rows })
      } else if (msg.type === 'clear') {
        if (!this.live) throw new Error('Unexpected clear')
        emit('clear', { pane: this.pane })
      } else {
        const part = msg.checkpoint
        if (part.part === 'begin') {
          if (this.live || this.scratch || !terminalSize(part.cols, part.rows))
            throw new Error('Invalid checkpoint header')
          this.scratch = new Terminal({
            allowProposedApi: true,
            cols: part.cols,
            rows: part.rows,
            scrollback: terminalService.scrollback,
          })
          this.state = part.state
          this.reader = new CheckpointReader(this.scratch)
          this.serializer = new SerializeAddon()
          this.scratch.loadAddon(this.serializer)
        }
        if (!this.reader || !this.scratch || !this.serializer) throw new Error('Missing checkpoint header')
        this.reader.accept(part)
        if (part.part === 'lines')
          part.lines.forEach((line, index) => {
            for (const [col, , link] of line.extended)
              if (link) this.links[part.buffer].push([part.first + index, col, link])
          })
        // The V3 server owns the canonical xterm cell snapshot. Decode it once
        // with the shared validator, then dispose of the temporary conversion grid.
        if (part.part === 'end') {
          const restored = this.serializer.serialize({ scrollback: terminalService.scrollback })
          emit('reset', { pane: this.pane, cols: this.scratch.cols, rows: this.scratch.rows })
          const state = this.state!,
            cols = this.scratch.cols,
            rows = this.scratch.rows
          const metadata = (buffer: 'normal' | 'alt') => {
            const buf = state[buffer]
            this.bytes(Buffer.from(bufferControls(state, buf, cols, rows)))
            // Link URIs are metadata, never executable terminal escapes.
            const links = new Map(state.links)
            const list = this.links[buffer]
            for (let i = 0; i < list.length; i += 256) {
              emit('links', {
                pane: this.pane,
                cells: list.slice(i, i + 256).flatMap(([line, col, id]) => {
                  const link = links.get(id)
                  return link && typeof link.uri === 'string' && link.uri.length <= 8192
                    ? [[line - buf.ybase, col, String(id), link.uri]]
                    : []
                }),
              })
            }
            emit('cursor', { pane: this.pane, x: buf.x, y: buf.y })
          }
          if (state.active === 'alt') {
            const normal = this.serializer.serialize({ excludeAltBuffer: true, excludeModes: true })
            this.bytes(Buffer.from(normal))
            metadata('normal')
            this.bytes(Buffer.from(restored.slice(normal.length)))
          } else this.bytes(Buffer.from(restored))
          metadata(state.active)
          this.bytes(Buffer.from(terminalControls(state)))
          if (state.dec.origin) {
            this.bytes(Buffer.from('\x1b[?6h'))
            emit('cursor', { pane: this.pane, x: state[state.active].x, y: state[state.active].y })
          }
          this.state = undefined
          this.links = { normal: [], alt: [] }
          this.scratch.dispose()
          this.scratch = undefined
          this.reader = undefined
          this.serializer = undefined
          this.live = true
        } else {
          done()
          return
        }
      }
      this.barrier(done)
    } catch (e) {
      this.failed(message(e))
    }
  }
  flush(done: () => void) {
    if (this.live) this.barrier(done)
    else this.failed('Incomplete terminal checkpoint')
  }
}
interface Attachment {
  key: string
  launch: DesktopLaunch
  socket: TerminalSocket
  rendering: NativeRendering
  activity: TerminalActivity
  focused: boolean
  cols: number
  rows: number
}
const creations = new Map<number, { key: string; id: string }>()
const panes = new Map<number, Attachment>()
const attach = async (launch: DesktopLaunch, window?: number) => {
  if (closing) return
  const key = desktopSessionId(launch)
  for (const [pane, existing] of panes)
    if (existing.key === key) {
      await existing.socket.activate(launch.token)
      emit('select', { pane })
      return
    }
  const pane = ++serial
  const rendering = new NativeRendering(pane, reason => state.socket.fail(reason))
  const socket = new TerminalSocket(
    launch.token,
    () => ({ cols: state.cols, rows: state.rows }),
    rendering,
    {
      state: connection => {
        state.activity.setActive(state.focused && connection.kind === 'connected')
        emit('connection', {
          pane,
          state:
            connection.kind === 'connected'
              ? { ...connection, routeLabel: terminalRouteLabels[connection.route] }
              : connection,
        })
      },
      hello: msg => {
        emit('title', { pane, title: msg.session.name })
        run(
          recent
            .remember({
              server: launch.server,
              accountId: launch.accountId,
              targetId: launch.targetId,
              sessionId: launch.sessionId,
              id: key,
              title: msg.session.name,
              tool: msg.session.tool,
              lastConnectedAt: Date.now(),
            })
            .then(snapshot),
        )
      },
      signal: s => {
        if (s.signal.type === 'files.changed') emit('filesChanged', { pane })
        if (s.signal.type === 'browser.open') {
          try {
            emit('browser', { url: browserUrl(s.signal.payload) })
          } catch (e) {
            emit('error', { pane, message: message(e) })
          }
        }
      },
      activity: activity => {
        if (!activity) {
          state.activity.update(null)
          emit('activity', { pane, activity })
          return
        }
        // Apply the observation only once the native pane has received this exact activity.
        rendering.barrier(() => state.activity.update(activity), 'activity', { activity })
      },
      deliveries: waiting => emit('deliveries', { pane, waiting }),
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
    rendering,
    cols: 80,
    rows: 24,
    focused: false,
    activity: new TerminalActivity(socket, message => emit('error', { pane, message })),
  }
  panes.set(pane, state)
  emit('opened', { pane, window, title: launch.title, server: launch.server })
  state.socket.open()
}
type Cmd = {
  op: string
  window: number
  pane: number
  id: number
  seq: number
  origin: string
  value: string
  text: string
  data: string
  active: boolean
  cols: number
  rows: number
  answer: boolean
  fontSize: number
  sound: boolean
  localShell: string | null
  target: string
  requestId: string
  input: SessionInput
  file: unknown
  path: string
  mime: string
}
async function handle(c: Cmd) {
  switch (c.op) {
    case 'answer':
      prompts.get(c.id)?.(c.answer)
      prompts.delete(c.id)
      return
    case 'link':
      if (c.value.startsWith('outpost://connect?')) {
        await accounts.login(parseDesktopConnectUrl(c.value))
      } else if (c.value.startsWith('outpost://login/')) {
        for (const ref of (await accounts.complete(c.value)) ?? []) await attach(await accounts.launch(ref), c.window)
      } else {
        const l = await accounts.connect(parseDesktopEntry(c.value))
        if (l) await attach(l, c.window)
      }
      return refresh()
    case 'login':
      await accounts.login(c.origin)
      return refresh()
    case 'cancel':
      accounts.cancel(c.origin)
      return
    case 'logout':
      if (await accounts.logout(c.origin)) {
        for (const [id, p] of panes)
          if (p.launch.server === c.origin) {
            p.activity.dispose()
            p.socket.close()
            p.rendering.dispose()
            panes.delete(id)
            emit('connection', { pane: id, state: { kind: 'closed', message: 'Signed out' } })
          }
        await recent.retain(ref => accounts.hasAccount(ref.server, ref.accountId))
        await refresh()
      }
      return
    case 'refresh':
      return refresh()
    case 'forget':
      await recent.clear()
      return snapshot()
    case 'choose': {
      const ref = catalogue.find(s => s.id === c.value) ?? recent.get(c.value)
      if (!ref) throw new Error('Session is no longer available')
      return attach(await accounts.launch(ref), c.window)
    }
    case 'prefs':
      await prefs.set({ fontSize: c.fontSize, sound: c.sound }, c.localShell)
      emit('prefs', { ...prefs.value, localShell: prefs.localShell, profiles })
      return
    case 'targets': {
      const s = accounts.creationServers().find(s => s.summary.origin === c.origin)
      if (s)
        emit('targets', { window: c.window, origin: c.origin, targets: await s.targets(new AbortController().signal) })
      return
    }
    case 'options': {
      const s = accounts.creationServers().find(s => s.summary.origin === c.origin)
      if (s)
        emit('options', {
          window: c.window,
          origin: c.origin,
          target: c.target,
          ...(await s.options(c.target, new AbortController().signal)),
        })
      return
    }
    case 'create': {
      const s = accounts.creationServers().find(s => s.summary.origin === c.origin)
      if (!s) throw new Error('Sign in first')
      const key = JSON.stringify([c.origin, c.target, c.input])
      let request = creations.get(c.window)
      if (request?.key !== key) {
        request = { key, id: randomUUID() }
        creations.set(c.window, request)
      }
      const item = await s.create(c.target, c.input, request.id)
      await attach(await accounts.launch(item), c.window)
      creations.delete(c.window)
      return
    }
  }
  const p = panes.get(c.pane)
  if (!p) return
  switch (c.op) {
    case 'ack':
      return p.rendering.ack(c.seq)
    case 'input':
      p.socket.input(Buffer.from(c.data, 'base64'))
      return
    case 'resize':
      if (terminalSize(c.cols, c.rows)) {
        p.cols = c.cols
        p.rows = c.rows
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
      p.activity.dispose()
      p.socket.close()
      p.rendering.dispose()
      panes.delete(c.pane)
      return
    case 'draft':
      return p.socket.draft(c.active)
    case 'submit':
      await p.socket.submit(c.text)
      emit('submitted', { pane: c.pane, text: c.text })
      return
    case 'clear':
      return p.socket.clear()
    case 'deliver':
      return p.socket.deliverNow()
    case 'image':
      return p.socket.pasteImage(new File([Buffer.from(c.data, 'base64')], 'clipboard', { type: c.mime }))
    case 'files':
      emit('files', { pane: c.pane, files: await p.socket.listFiles(AbortSignal.timeout(20000)) })
      return
    case 'preview': {
      const file = parseSessionFile(c.file)
      if (!previewImage(file)) throw new Error('Preview not supported.')
      const blob = await p.socket.readFile(file, AbortSignal.timeout(120000))
      if (panes.get(c.pane) === p)
        emit('preview', {
          pane: c.pane,
          id: file.id,
          mime: file.mediaType,
          data: Buffer.from(await blob.arrayBuffer()).toString('base64'),
        })
      return
    }
    case 'saveFile': {
      const file = parseSessionFile(c.file)
      const blob = await p.socket.readFile(file, AbortSignal.timeout(120000))
      await writeFile(c.path, Buffer.from(await blob.arrayBuffer()))
      return
    }
    case 'deleteFile': {
      const file = parseSessionFile(c.file)
      await p.socket.removeFile(file.id, AbortSignal.timeout(120000))
      return handle({ ...c, op: 'files' })
    }
  }
}
async function main() {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await trust.load()
  await accounts.load()
  await recent.load()
  await recent.retain(ref => accounts.hasAccount(ref.server, ref.accountId))
  await prefs.load()
  emit('prefs', { ...prefs.value, localShell: prefs.localShell, profiles })
  snapshot()
  const lines = createInterface({ input: process.stdin })
  lines.on('line', line => {
    try {
      const c = JSON.parse(line) as Cmd
      run(handle(c), { window: c.window, pane: c.pane })
    } catch (e) {
      emit('error', { message: message(e) })
    }
  })
  lines.on('close', async () => {
    closing = true
    for (const answer of prompts.values()) answer(false)
    prompts.clear()
    accounts.dispose()
    for (const p of panes.values()) {
      p.activity.dispose()
      p.socket.close()
      p.rendering.dispose()
    }
    panes.clear()
    // Every command preceding EOF was dispatched. Wait for its local writes before
    // ending the helper, including a credential exchange already in its saving phase.
    await Promise.all(pending)
    process.exit(0)
  })
  void refresh().catch(e => emit('error', { message: message(e) }))
}
main().catch(e => {
  emit('error', { message: message(e) })
  process.exitCode = 1
})
