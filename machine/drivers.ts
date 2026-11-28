// Talking to a session's running driver over its private socket, and ending
// process trees. Sockets live in owner-only directories of the state directory.
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import type { SessionActivity } from '../shared/activity'
import { FrameDecoder, terminalControl } from '../shared/node/terminalFrames'
import { processStat, type ProcessStat } from './processes'
import { chatSocket, machineExecutable, socketAddress, statePath, terminalSocket } from './state'

interface DriverStatus {
  version: string
  protocol: number
  pid: number
  clients: number
  activity: SessionActivity
  /** The configuration revision it started with. */
  revision: number
}

/** One request and its reply; null when nothing listens. */
export function request<T = Record<string, unknown>>(
  socket: string,
  message: object,
  timeoutMs = 3000,
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const connection = connect(socketAddress(socket))
    const decoder = new FrameDecoder()
    const timer = setTimeout(() => {
      connection.destroy()
      reject(new Error('The session’s process did not answer in time.'))
    }, timeoutMs)
    connection.on('connect', () => connection.write(terminalControl(message)))
    connection.on('data', (data: Buffer) => {
      try {
        for (const frame of decoder.feed(data)) {
          if (frame.kind !== 'C') continue
          clearTimeout(timer)
          connection.end()
          const reply = JSON.parse(frame.payload.toString('utf8'))
          if (reply.type === 'error')
            return reject(new Error(reply.message ?? 'The session’s process refused the request.'))
          return resolve(reply as T)
        }
      } catch (error) {
        clearTimeout(timer)
        connection.destroy()
        reject(error)
      }
    })
    connection.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(null)
      else reject(error)
    })
    connection.on('close', () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}

async function probeDriver(socket: string): Promise<DriverStatus | null> {
  const status = () => request<DriverStatus>(socket, { type: 'status' })
  try {
    return await status()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // A driver can exit between accepting the probe and reading it. A fresh
    // connection observes either the current driver or its closed socket.
    if (code === 'ECONNRESET' || code === 'EPIPE') return status()
    throw error
  }
}

export async function driverStatus(session: string) {
  const [terminal, chat] = await Promise.all([probeDriver(terminalSocket(session)), probeDriver(chatSocket(session))])
  return { terminal, chat }
}

const same = (process: ProcessStat) => processStat(process.pid)?.start === process.start

/** End a process and every descendant: children first, SIGTERM then SIGKILL. */
export async function endTree(root: number) {
  const first = processStat(root)
  if (!first) return
  const all = readdirSync('/proc')
    .filter(name => /^\d+$/.test(name))
    .map(name => processStat(Number(name)))
    .filter((item): item is ProcessStat => item !== null)
  const tree = [first]
  for (let index = 0; index < tree.length; index++)
    for (const item of all)
      if (item.parent === tree[index].pid && !tree.some(known => known.pid === item.pid)) tree.push(item)
  tree.reverse()
  const signal = (name: NodeJS.Signals) => {
    for (const item of tree)
      if (same(item))
        try {
          process.kill(item.pid, name)
        } catch {
          /* Gone. */
        }
  }
  const wait = async (ms: number) => {
    const deadline = Date.now() + ms
    while (tree.some(same) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  }
  signal('SIGTERM')
  await wait(3000)
  signal('SIGKILL')
  await wait(2000)
}

/** Stop a session's driver. It ends its own tool; if it does not answer, its
 * process tree is ended after checking that the PID really is that driver. */
export async function stopDriver(session: string) {
  for (const [socket, role] of [
    [terminalSocket(session), 'serve'],
    [chatSocket(session), 'chat-serve'],
  ] as const) {
    let status: DriverStatus | null
    try {
      status = await probeDriver(socket)
    } catch {
      status = null
    }
    if (!status) {
      rmSync(statePath(socket), { force: true })
      continue
    }
    const stopped = await request(socket, { type: 'stop' }, 10_000).catch(() => null)
    if (!stopped || (await probeDriver(socket).catch(() => null))) {
      let command: string[] = []
      try {
        command = readFileSync(`/proc/${status.pid}/cmdline`, 'utf8').split('\0')
      } catch {
        /* It exited meanwhile. */
      }
      if (
        command.includes(role) &&
        command.some(part => part === machineExecutable() || part.endsWith('outpost-terminal'))
      )
        await endTree(status.pid)
    }
    rmSync(statePath(socket), { force: true })
  }
}
