// `outpost-terminal serve`: the persistent PTY of one terminal session. It owns
// the coding tool's process, the authoritative screen, and the session's
// activity, and serves viewers, hooks and helpers on a private Unix socket.
import { createServer, type Socket } from 'node:net'
import { chmodSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import headless from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { checkpoint, clearTerminal, headlessColors, writeHeadless } from '../shared/terminalCheckpoint'
import { terminalService, terminalSize } from '../shared/terminalService'
import { FrameDecoder, terminalControl, terminalFrame } from '../shared/node/terminalFrames'
import { isUserInput, TerminalActivity } from './activity'
import { TerminalAttachment } from './attachment'
import { Deliveries } from './delivery'
import { endTree } from './drivers'
import { harness } from './harnesses'
import { readRegistry, session as findSession } from './registry'
import { Sequences } from './sequences'
import { socketAddress, statePath } from './state'

interface Launch {
  socket: string
  session: string
  revision: number
  conversation: string
  /** Why activity tracking is degraded, if it is. */
  problem: string | null
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
const signalMs = 12_000

export async function serveTerminal() {
  process.umask(0o077)
  // Configuration travels through a pipe, never argv or an on-disk file.
  let config = ''
  for await (const chunk of process.stdin) {
    config += chunk.toString()
    if (config.length > 1024 * 1024) throw new Error('Launch configuration is too large')
  }
  const launch: Launch = JSON.parse(config)
  if (!terminalSize(launch.cols, launch.rows) || !/^terminals\/[a-f0-9-]+\.sock$/.test(launch.socket))
    throw new Error('Invalid session configuration')
  const record = findSession(readRegistry(), launch.session)
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
  /** Helpers waiting for a viewer to act on their signal. */
  const signals = new Map<string, { socket: Socket; timer: NodeJS.Timeout }>()
  let controller: Socket | undefined
  let ended = false
  let childExited = false
  let ptyEnded = false
  let listening = false
  let lastOutputAt = 0
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  let restoring = 0
  const sendControl = (socket: Socket, message: object) => {
    if (!socket.destroyed && !socket.writableEnded) socket.write(terminalControl(message))
  }
  const broadcast = (packet: Buffer) => {
    for (const client of clients.values()) client.attachment.output(packet)
  }
  const activity = new TerminalActivity(
    record,
    launch.conversation,
    harness(record.tool),
    value => {
      broadcast(terminalControl({ type: 'activity', activity: value }))
      // A change may let a waiting message in, or settle the one in progress.
      setImmediate(() => deliveries.tick())
    },
    launch.problem,
  )
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
  // The machine is the sole authority for terminal queries, including when no
  // renderer exists. Renderers forward only actual input and focus/mouse events.
  const reply = (data: string) => {
    if (!childExited && !pty.closed) pty.write(data)
  }
  term.onData(reply)
  headlessColors(term, reply)
  const child = Bun.spawn(launch.command, { cwd: launch.cwd, env: launch.env, terminal: pty })

  // Messages from other sessions, channels and schedules.
  /** While a message goes in, input from viewers waits so it cannot interleave. */
  let held: (string | Buffer)[] | null = null
  const write = (data: string | Buffer) => {
    if (held) held.push(data)
    else if (!childExited) pty.write(data)
  }
  const deliveries: Deliveries = new Deliveries(record.id, {
    mode() {
      // The setting changes while the session runs; it is read only while a message waits.
      try {
        return findSession(readRegistry(), record.id).delivery
      } catch {
        return 'manual'
      }
    },
    activity: () => activity.current,
    reply: () => activity.lastReply(),
    changed: waiting => broadcast(terminalControl({ type: 'deliveries', waiting })),
    type(text) {
      if (childExited) return
      pty.write(term.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text)
      held = []
      // Enter on its own, after the paste, so the tool does not read it as pasted text.
      setTimeout(() => {
        const waiting = held ?? []
        held = null
        if (childExited) return
        pty.write('\r')
        for (const data of waiting) pty.write(data)
      }, 150)
    },
  })
  const deliveryTimer = setInterval(() => deliveries.tick(), 500)
  deliveryTimer.unref()
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
  const stop = async () => {
    if (!childExited && child.pid) await endTree(child.pid)
    close()
  }

  /** Requests from processes that do not view the terminal. */
  const oneShot = (socket: Socket, message: Record<string, unknown>) => {
    switch (message.type) {
      case 'status':
        sendControl(socket, {
          type: 'status',
          version: terminalService.version,
          protocol: terminalService.protocol,
          pid: process.pid,
          clients: clients.size,
          activity: activity.current,
          revision: launch.revision,
        })
        return socket.end()
      case 'stop':
        sendControl(socket, { type: 'result', ok: true })
        socket.end()
        return void stop()
      case 'acknowledge':
        sendControl(socket, { type: 'result', ok: activity.acknowledge(String(message.completionId)) })
        return socket.end()
      case 'hook':
        // From `outpost-terminal hook`, run by the tool's own hooks.
        void activity.hookEvent((message.payload ?? {}) as Record<string, unknown>)
        sendControl(socket, { type: 'result', ok: true })
        return socket.end()
      case 'deliver': {
        // From the node: a message for the agent, typed in when nothing is in the way.
        if (
          typeof message.key !== 'string' ||
          !/^[A-Za-z0-9_-]{1,80}$/.test(message.key) ||
          typeof message.text !== 'string' ||
          !message.text.trim() ||
          Buffer.byteLength(message.text) > 64 * 1024
        )
          throw new Error('Invalid message for the session')
        sendControl(socket, { type: 'result', ok: true, delivery: deliveries.add(message.key, message.text) })
        return socket.end()
      }
      case 'deliveries':
        if (!Array.isArray(message.keys) || message.keys.length > 100) throw new Error('Invalid delivery query')
        sendControl(socket, { type: 'result', ok: true, deliveries: deliveries.status(message.keys.map(String)) })
        return socket.end()
      case 'files':
        // The agent stored a file; viewers refresh their list.
        broadcast(terminalControl({ type: 'files' }))
        sendControl(socket, { type: 'result', ok: true })
        return socket.end()
      case 'signal': {
        // From `outpost-terminal open|signal`: the most recent viewer acts on it.
        const viewer = activeViewer() ?? [...clients.keys()].at(-1)
        if (!viewer) {
          sendControl(socket, {
            type: 'result',
            ok: false,
            message: 'No Outpost terminal is connected to this session.',
          })
          return socket.end()
        }
        const id = randomUUID()
        const timer = setTimeout(() => {
          signals.delete(id)
          sendControl(socket, { type: 'result', ok: false, message: 'Outpost did not respond in time.' })
          socket.end()
        }, signalMs)
        signals.set(id, { socket, timer })
        socket.setTimeout(0)
        return clients.get(viewer)!.attachment.output(terminalControl({ type: 'signal', id, signal: message.signal }))
      }
    }
    throw new Error('Unknown terminal operation')
  }

  const server = createServer(socket => {
    sockets.add(socket)
    socket.setTimeout(10_000, () => socket.destroy())
    socket.on('error', () => {})
    socket.on('close', () => {
      sockets.delete(socket)
      clients.delete(socket)
      deliveries.draft(socket, false)
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
            write(packet.payload)
            // Focus reports are automatic; anything else is the user typing.
            if (isUserInput(packet.payload)) {
              activity.input()
              deliveries.input(packet.payload)
            }
            continue
          }
          if (packet.kind !== 'C') throw new Error('Invalid terminal frame')
          const message = JSON.parse(packet.payload.toString())
          if (!attached && message.type !== 'attach') {
            oneShot(socket, message)
          } else if (message.type === 'attach' && !attached) {
            if (message.protocol !== terminalService.protocol)
              throw new Error('Terminal service protocol mismatch; install the current dependency')
            if (!terminalSize(message.cols, message.rows)) throw new Error('Invalid terminal size')
            // A raw full-width checkpoint can hold about 50 MiB of cells. Bound
            // concurrent captures; clients retry without pausing the live PTY.
            if (restoring >= 2) {
              sendControl(socket, {
                type: 'error',
                retryable: true,
                message: 'Other viewers are restoring. Trying again shortly.',
              })
              socket.end()
              return
            }
            // A newly loading/hidden viewer must not resize an existing viewer.
            // It takes control only when the UI reports activation after ready.
            if (!controller) resize(message.cols, message.rows)
            const parts = checkpoint(term)
            restoring++
            const attachment = new TerminalAttachment(socket)
            clients.set(socket, { attachment, cols: message.cols, rows: message.rows, active: false })
            attached = true
            controller ??= socket
            socket.setTimeout(0)
            // The capture above is atomic; subsequent bytes/geometry queue in
            // this attachment while encoding and transport yield to the PTY.
            void attachment
              .restore(parts)
              .catch(error => {
                if (!socket.destroyed) {
                  sendControl(socket, { type: 'error', message: (error as Error).message })
                  socket.destroy()
                }
              })
              .finally(() => {
                restoring--
              })
            attachment.output(terminalControl({ type: 'activity', activity: activity.current }))
            attachment.output(terminalControl({ type: 'deliveries', waiting: deliveries.count }))
          } else if (message.type === 'draft') {
            // The viewer's message box has text: messages wait until it is sent or cleared.
            if (typeof message.active !== 'boolean') throw new Error('Invalid draft state')
            deliveries.draft(socket, message.active)
          } else if (message.type === 'deliver-now') {
            deliveries.deliverNow()
          } else if (message.type === 'ping') {
            sendControl(socket, { type: 'result', id: message.id, ok: true })
          } else if (message.type === 'acknowledge') {
            const ok = activity.acknowledge(String(message.completionId))
            sendControl(socket, { type: 'result', id: message.id, ok, ...(ok ? {} : { message: 'Already seen.' }) })
          } else if (message.type === 'signal-result') {
            const waiting = signals.get(message.id)
            if (!waiting) continue
            signals.delete(message.id)
            clearTimeout(waiting.timer)
            sendControl(waiting.socket, { type: 'result', ok: message.ok === true, message: message.message })
            waiting.socket.end()
          } else if (message.type === 'clear') {
            // Clear the authoritative buffer, then apply the same operation in
            // every viewer's ordered stream. No bytes are sent to the coding tool.
            clearTerminal(term)
            broadcast(terminalControl({ type: 'clear' }))
            sendControl(socket, { type: 'result', id: message.id, ok: true })
          } else if (message.type === 'resize') {
            if (!terminalSize(message.cols, message.rows)) throw new Error('Invalid terminal size')
            const client = clients.get(socket)!
            client.cols = message.cols
            client.rows = message.rows
            if (controller === socket) resize(message.cols, message.rows)
          } else if (message.type === 'focus') {
            if (typeof message.active !== 'boolean') throw new Error('Invalid terminal focus')
            const client = clients.get(socket)!
            client.active = message.active
            // Insertion order records activation recency as well as attachment.
            if (client.active) {
              clients.delete(socket)
              clients.set(socket, client)
              control(socket)
            } else if (controller === socket) control(activeViewer() ?? socket)
          } else if (message.type === 'send' || message.type === 'paste') {
            if (typeof message.data !== 'string' || Buffer.byteLength(message.data) > 64 * 1024)
              throw new Error('Input exceeds 64 KiB')
            let data = message.data
            if (message.type === 'paste' && term.modes.bracketedPasteMode) data = `\x1b[200~${data}\x1b[201~`
            if (childExited) {
              sendControl(socket, { type: 'result', id: message.id, ok: false, message: 'The coding tool exited.' })
            } else {
              write(data)
              activity.input()
              deliveries.input(message.data)
              sendControl(socket, { type: 'result', id: message.id, ok: true })
            }
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
    server.listen(socketAddress(launch.socket), () => {
      chmodSync(statePath(launch.socket), 0o600)
      resolve()
    })
  })
  const close = () => {
    if (ended) return
    ended = true
    clearTimeout(drainTimer)
    clearInterval(deliveryTimer)
    activity.exited()
    deliveries.exited()
    for (const { socket, timer } of signals.values()) {
      clearTimeout(timer)
      sendControl(socket, { type: 'result', ok: false, message: 'The Outpost terminal disconnected.' })
      socket.end()
    }
    for (const client of clients.values()) client.attachment.end()
    for (const socket of sockets) {
      if (!clients.has(socket)) socket.end()
    }
    server.close()
    try {
      unlinkSync(statePath(launch.socket))
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
  process.on('SIGTERM', () => void stop())
  process.on('SIGINT', () => void stop())
  listening = true
  if (ptyEnded) close()
  // A reusable Bun.Terminal retains its slave descriptor; its exit callback
  // reports stream closure, not child exit. The coding process owns session
  // lifetime. Drain pending output briefly, but never wait for PTY EOF or an
  // inherited descriptor held by a background descendant.
  void child.exited.then(() => {
    childExited = true
    activity.exited()
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
