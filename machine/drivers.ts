// Talking to a session's running driver over its private socket, and ending
// process trees. Sockets live in owner-only directories of the state directory.
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import type { SessionActivity } from '../shared/activity'
import { FrameDecoder, terminalControl } from '../shared/node/terminalFrames'
import { machineExecutable, socketAddress, statePath } from './state'

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

export async function driverStatus(session: string) {
  const [terminal, chat] = await Promise.all([
    request<DriverStatus>(`terminals/${session}.sock`, { type: 'status' }),
    request<DriverStatus>(`chats/${session}.sock`, { type: 'status' }),
  ])
  return { terminal, chat }
}

interface Process {
  pid: number
  parent: number
  start: string
}

function processInfo(pid: number): Process | null {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').at(-1)!.trim().split(' ')
    if (fields[0] === 'Z' || fields[0] === 'X') return null
    return { pid, parent: Number(fields[1]), start: fields[19] }
  } catch {
    return null
  }
}
const same = (process: Process) => processInfo(process.pid)?.start === process.start

/** End a process and every descendant: children first, SIGTERM then SIGKILL. */
export async function endTree(root: number) {
  const first = processInfo(root)
  if (!first) return
  const all = readdirSync('/proc')
    .filter(name => /^\d+$/.test(name))
    .map(name => processInfo(Number(name)))
    .filter((item): item is Process => item !== null)
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
    [`terminals/${session}.sock`, 'serve'],
    [`chats/${session}.sock`, 'chat-serve'],
  ] as const) {
    let status: DriverStatus | null
    try {
      status = await request<DriverStatus>(socket, { type: 'status' })
    } catch {
      status = null
    }
    if (!status) {
      rmSync(statePath(socket), { force: true })
      continue
    }
    const stopped = await request(socket, { type: 'stop' }, 10_000).catch(() => null)
    if (!stopped || (await request(socket, { type: 'status' }).catch(() => null))) {
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
