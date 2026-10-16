import { createServer, type Socket } from 'node:net'
import { chmodSync, unlinkSync } from 'node:fs'
import headless from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { checkpoint, headlessColors, writeHeadless } from '../shared/terminalCheckpoint'
import { terminalService, terminalSize } from '../shared/terminalService'
import { FrameDecoder, terminalControl, terminalFrame } from '../shared/node/terminalFrames'
import { Sequences } from './sequences'
import { TerminalAttachment } from './attachment'

interface Launch {
  socket: string
  command: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}
interface Viewer {
  attachment: TerminalAttachment
  cols: number
  rows: number
  active: boolean
}

const outputQuietMs = 50
const outputDrainMs = 1000
const viewerDrainMs = 30_000

async function serve() {
  process.umask(0o077)
  // Configuration travels through a pipe, never argv or an on-disk secret file.
  let config = ''
  for await (const chunk of process.stdin) {
    config += chunk.toString()
    if (config.length > 1024 * 1024) throw new Error('Launch configuration is too large')
  }
  const launch: Launch = JSON.parse(config)
  if (!terminalSize(launch.cols, launch.rows) || !/^terminals\/[a-f0-9-]+\.sock$/.test(launch.socket))
    throw new Error('Invalid session configuration')
  const term = new headless.Terminal({
    cols: launch.cols,
    rows: launch.rows,
    scrollback: terminalService.scrollback,
    allowProposedApi: true,
    logLevel: 'off',
    cursorBlink: true,
  })
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'
  const sequences = new Sequences()
  const clients = new Map<Socket, Viewer>()
  const sockets = new Set<Socket>()
  let controller: Socket | undefined
  let ended = false
  let childExited = false
  let ptyEnded = false
  let listening = false
  let lastOutputAt = 0
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  const send = (socket: Socket, packet: Buffer) => {
    if (socket.destroyed || socket.writableEnded) return
    socket.write(packet)
  }
  const sendControl = (socket: Socket, message: object) => send(socket, terminalControl(message))
  const broadcast = (packet: Buffer) => {
    for (const client of clients.values()) client.attachment.output(packet)
  }
  const pty = new Bun.Terminal({
    cols: launch.cols,
    rows: launch.rows,
    data(_terminal, data) {
      if (ended) return
      lastOutputAt = performance.now()
      const complete = sequences.feed(Buffer.from(data))
      if (!complete) return
      writeHeadless(term, complete)
      broadcast(terminalFrame('O', Buffer.from(complete)))
    },
    exit() {
      ptyEnded = true
      if (listening) close()
    },
  })
  // The target is the sole authority for terminal queries, including when no
  // renderer exists. Renderers forward only actual input and focus/mouse events.
  const reply = (data: string) => {
    if (!childExited && !pty.closed) pty.write(data)
  }
  term.onData(reply)
  headlessColors(term, reply)
  const child = Bun.spawn(launch.command, { cwd: launch.cwd, env: launch.env, terminal: pty })
  const resize = (cols: number, rows: number) => {
    if (!terminalSize(cols, rows)) throw new Error('Invalid terminal size')
    if (childExited) return
    if (cols === term.cols && rows === term.rows) return
    term.resize(cols, rows)
    // Every viewer applies the same geometry before receiving subsequent bytes.
    broadcast(terminalControl({ type: 'geometry', cols, rows }))
    pty.resize(cols, rows)
  }
  const control = (socket: Socket | undefined) => {
    controller = socket
    const client = socket && clients.get(socket)
    if (client && !ended) resize(client.cols, client.rows)
  }
  const activeViewer = () => [...clients].reverse().find(([, client]) => client.active)?.[0]
  const server = createServer(socket => {
    sockets.add(socket)
    socket.setTimeout(10_000, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('close', () => {
      sockets.delete(socket)
      clients.delete(socket)
      if (controller === socket) control(activeViewer() ?? [...clients.keys()].at(-1))
    })
    const decoder = new FrameDecoder()
    let attached = false
    socket.on('data', bytes => {
      try {
        for (const packet of decoder.feed(Buffer.from(bytes))) {
          // Shutdown owns socket closure: a restoring viewer must flush its
          // ordered snapshot/output/exit queue before sending EOF.
          if (ended) return
          if (packet.kind === 'I') {
            if (!attached || packet.payload.length > 64 * 1024) throw new Error('Invalid terminal input')
            if (!childExited) pty.write(packet.payload)
            continue
          }
          if (packet.kind !== 'C') throw new Error('Invalid terminal frame')
          const message = JSON.parse(packet.payload.toString())
          if (message.type === 'status' && !attached) {
            sendControl(socket, {
              version: terminalService.version,
              protocol: terminalService.protocol,
              pid: process.pid,
              clients: clients.size,
            })
            socket.end()
          } else if (message.type === 'attach' && !attached) {
            if (message.protocol !== terminalService.protocol)
              throw new Error('Terminal service protocol mismatch; install the current dependency')
            if (!terminalSize(message.cols, message.rows)) throw new Error('Invalid terminal size')
            // A newly loading/hidden viewer must not resize an existing viewer.
            // It takes control only when the UI reports activation after ready.
            if (!controller) resize(message.cols, message.rows)
            const parts = checkpoint(term)
            const attachment = new TerminalAttachment(socket)
            clients.set(socket, { attachment, cols: message.cols, rows: message.rows, active: false })
            attached = true
            controller ??= socket
            socket.setTimeout(0)
            // The capture above is atomic; subsequent bytes/geometry queue in
            // this attachment while encoding and transport yield to the PTY.
            void attachment.restore(parts).catch(error => {
              if (!socket.destroyed) {
                sendControl(socket, { type: 'error', message: (error as Error).message })
                socket.destroy()
              }
            })
          } else if (message.type === 'clear' && attached) {
            // Clear the authoritative buffer, then apply the same operation in
            // every viewer's ordered stream. No bytes are sent to the coding tool.
            term.clear()
            broadcast(terminalControl({ type: 'clear' }))
            sendControl(socket, { type: 'result', id: message.id, ok: true })
          } else if (message.type === 'resize' && attached) {
            if (!terminalSize(message.cols, message.rows)) throw new Error('Invalid terminal size')
            const client = clients.get(socket)!
            client.cols = message.cols
            client.rows = message.rows
            if (controller === socket) resize(message.cols, message.rows)
          } else if (message.type === 'focus' && attached) {
            if (typeof message.active !== 'boolean') throw new Error('Invalid terminal focus')
            const client = clients.get(socket)!
            client.active = message.active
            // Insertion order records activation recency as well as attachment.
            if (client.active) {
              clients.delete(socket)
              clients.set(socket, client)
              control(socket)
            } else if (controller === socket) control(activeViewer() ?? socket)
          } else if ((message.type === 'send' && attached) || message.type === 'paste') {
            if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > 64 * 1024)
              throw new Error('Input exceeds 64 KiB')
            let data = message.data
            if (message.type === 'paste' && term.modes.bracketedPasteMode) data = `\x1b[200~${data}\x1b[201~`
            if (childExited) {
              sendControl(socket, { type: 'result', id: message.id, ok: false, message: 'The coding tool exited.' })
            } else {
              pty.write(data)
              sendControl(socket, { type: 'result', id: message.id, ok: true, reference: message.reference })
            }
            if (!attached) socket.end()
          } else throw new Error('Unknown terminal operation')
        }
      } catch (error) {
        sendControl(socket, { type: 'error', message: (error as Error).message })
        socket.end()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(launch.socket, () => {
      chmodSync(launch.socket, 0o600)
      resolve()
    })
  })
  const close = () => {
    if (ended) return
    ended = true
    clearTimeout(drainTimer)
    for (const client of clients.values()) client.attachment.end()
    for (const socket of sockets) {
      if (!clients.has(socket)) socket.end()
    }
    server.close()
    try {
      unlinkSync(launch.socket)
    } catch {
      /* Already removed during explicit termination. */
    }
    pty.close()
    term.dispose()
    // Slow readers cannot retain a dead service indefinitely. Healthy viewers
    // finish naturally after their queued output and exit frame have flushed.
    setTimeout(() => process.exit(0), viewerDrainMs).unref()
  }
  process.on('SIGHUP', () => {}) // SSH/client lifetime never owns this process.
  process.on('SIGTERM', () => {
    child.kill()
    close()
  })
  process.on('SIGINT', () => {
    child.kill()
    close()
  })
  listening = true
  if (ptyEnded) close()
  // A reusable Bun.Terminal retains its slave descriptor; its exit callback
  // reports stream closure, not child exit. The coding process owns session
  // lifetime. Drain pending output briefly, but never wait for PTY EOF or an
  // inherited descriptor held by a background descendant.
  void child.exited.then(() => {
    childExited = true
    if (ended) return
    lastOutputAt = performance.now()
    const deadline = lastOutputAt + outputDrainMs
    const drained = () => {
      const now = performance.now()
      const remaining = Math.min(lastOutputAt + outputQuietMs, deadline) - now
      if (remaining > 0) drainTimer = setTimeout(drained, remaining)
      else close()
    }
    drainTimer = setTimeout(drained, outputQuietMs)
  })
}

if (process.argv.includes('--version'))
  console.log(`outpost-terminal ${terminalService.version} protocol ${terminalService.protocol}`)
else if (process.argv.includes('serve'))
  await serve().catch(error => {
    console.error(error)
    process.exit(1)
  })
else {
  console.error('Usage: outpost-terminal serve | --version')
  process.exit(2)
}
