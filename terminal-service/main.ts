import { createServer, type Socket } from 'node:net'
import { chmodSync, unlinkSync } from 'node:fs'
import headless from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { checkpoint, headlessColors, writeHeadless } from '../shared/terminalCheckpoint'
import { terminalService, terminalSize } from '../shared/terminalService'
import { FrameDecoder, terminalControl, terminalFrame } from '../shared/node/terminalFrames'
import { Sequences } from './sequences'

interface Launch {
  socket: string
  command: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

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
  const clients = new Set<Socket>()
  const sockets = new Set<Socket>()
  let controller: Socket | undefined
  let ended = false
  let ptyEnded = false
  let listening = false
  const send = (socket: Socket, packet: Buffer) => {
    if (socket.destroyed) return
    // Snapshot data is bounded by screen geometry + history. A slow client is
    // disconnected rather than stopping the PTY; it can restore a fresh snapshot.
    if (socket.writableLength > 96 * 1024 * 1024) return socket.destroy()
    socket.write(packet)
  }
  const sendControl = (socket: Socket, message: object) => send(socket, terminalControl(message))
  const broadcast = (packet: Buffer) => {
    for (const client of clients) send(client, packet)
  }
  const pty = new Bun.Terminal({
    cols: launch.cols,
    rows: launch.rows,
    data(_terminal, data) {
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
  term.onData(data => pty.write(data))
  headlessColors(term, data => pty.write(data))
  const child = Bun.spawn(launch.command, { cwd: launch.cwd, env: launch.env, terminal: pty })
  const resize = (cols: number, rows: number) => {
    if (!terminalSize(cols, rows)) throw new Error('Invalid terminal size')
    if (cols === term.cols && rows === term.rows) return
    term.resize(cols, rows)
    // Every viewer applies the same geometry before receiving subsequent bytes.
    broadcast(terminalControl({ type: 'geometry', cols, rows }))
    pty.resize(cols, rows)
  }
  const server = createServer(socket => {
    sockets.add(socket)
    socket.setTimeout(10_000, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('close', () => {
      sockets.delete(socket)
      clients.delete(socket)
      if (controller === socket) controller = [...clients].at(-1)
    })
    const decoder = new FrameDecoder()
    let attached = false
    socket.on('data', bytes => {
      try {
        for (const packet of decoder.feed(Buffer.from(bytes))) {
          if (ended) return socket.end()
          if (packet.kind === 'I') {
            if (!attached || packet.payload.length > 64 * 1024) throw new Error('Invalid terminal input')
            pty.write(packet.payload)
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
            resize(message.cols, message.rows)
            // Everything below is synchronous. The next PTY callback is strictly
            // after this checkpoint, so no output can be omitted or duplicated.
            for (const part of checkpoint(term)) sendControl(socket, { type: 'restore', checkpoint: part })
            attached = true
            clients.add(socket)
            controller = socket
            socket.setTimeout(0)
            sendControl(socket, { type: 'ready' })
          } else if (message.type === 'resize' && attached) {
            if (controller === socket) resize(message.cols, message.rows)
          } else if ((message.type === 'send' && attached) || message.type === 'paste') {
            if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > 64 * 1024)
              throw new Error('Input exceeds 64 KiB')
            let data = message.data
            if (message.type === 'paste' && term.modes.bracketedPasteMode) data = `\x1b[200~${data}\x1b[201~`
            pty.write(data)
            sendControl(socket, { type: 'result', id: message.id, ok: true, reference: message.reference })
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
    broadcast(terminalControl({ type: 'exit', reason: 'ended' }))
    for (const socket of sockets) socket.end()
    server.close()
    try {
      unlinkSync(launch.socket)
    } catch {
      /* Already removed during explicit termination. */
    }
    pty.close()
    term.dispose()
    setTimeout(() => process.exit(0), 2000).unref()
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
  // PTY EOF follows its last output callback. Process exit can precede unread
  // output, so it must not close the PTY early and lose the final response.
  listening = true
  if (ptyEnded) close()
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
