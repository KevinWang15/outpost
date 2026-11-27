// Outpost's state directory on a machine (~/.outpost) and the primitives every
// writer uses: owner-only atomic files and a cross-process lock.
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { dirname, join, relative } from 'node:path'

// Keep machine/state.ts free of non-node imports so raw Node subprocesses can import it directly.
const uuidRegex = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

/** The execution account's Outpost directory, or the directory bound to a session command. */
export const state = { directory: join(homedir(), '.outpost') }

export interface SessionBinding {
  session: string
  driver: 'terminal' | 'chat'
}

/** Binding for `outpost-terminal mcp`: either a managed session or a standalone SSH-wrapped agent. */
export type McpBinding = SessionBinding | { session: null; driver: 'ssh' }

/** Read the complete launch binding before selecting its state directory. */
export function useSessionBinding(): SessionBinding | null {
  const session = process.env.OUTPOST_SESSION_ID
  const driver = process.env.OUTPOST_DRIVER
  const directory = process.env.OUTPOST_STATE_DIRECTORY
  if (session === undefined && driver === undefined && directory === undefined) return null
  if (
    !session ||
    !uuidRegex.test(session) ||
    (driver !== 'terminal' && driver !== 'chat') ||
    !directory?.startsWith('/')
  )
    throw new Error('Run this command inside an Outpost session.')
  state.directory = directory
  return { session, driver }
}

/** Read an MCP binding (managed session or standalone SSH wrapper). */
export function useMcpBinding(): McpBinding | null {
  const session = process.env.OUTPOST_SESSION_ID
  const driver = process.env.OUTPOST_DRIVER
  const directory = process.env.OUTPOST_STATE_DIRECTORY
  if (driver === 'ssh' && session === undefined && directory?.startsWith('/')) {
    state.directory = directory
    return { session: null, driver: 'ssh' }
  }
  return useSessionBinding()
}

export const statePath = (...parts: string[]) => join(state.directory, ...parts)
export const terminalSocket = (session: string) => `terminals/${session}.sock`
export const chatSocket = (session: string) => `chats/${session}.sock`

export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return homedir() + path.slice(1)
  return path
}

/** Validate shell argument syntax with `bash -n`. Returns an error message or null. */
export function validateBashArgs(args: string, bash = 'bash'): { missing?: boolean; error?: string } | null {
  const syntax = spawnSync(bash, ['-n', '-c', `exec "$1" ${args}`], { encoding: 'utf8' })
  if (syntax.error) return { missing: true }
  if (syntax.status !== 0) return { error: syntax.stderr.trim() }
  return null
}

/** Flush a file or directory descriptor to durable storage. */
export function syncDirectory(path: string) {
  const descriptor = openSync(path, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

/** Read a bounded JSON launch configuration piped to stdin by the node. */
export async function readLaunchConfig(): Promise<unknown> {
  let config = ''
  for await (const chunk of process.stdin) {
    config += chunk.toString()
    if (config.length > 1024 * 1024) throw new Error('Launch configuration is too large')
  }
  return JSON.parse(config)
}

/** Work in the state directory (created on first use). */
export function enterState() {
  mkdirSync(state.directory, { recursive: true, mode: 0o700 })
  process.chdir(state.directory)
}

/** How to address a Unix socket below the state directory. Socket paths are
 * limited to about 100 bytes, so a long one is given relative to the working
 * directory, which for Outpost's processes is the state directory. */
export function socketAddress(...parts: string[]) {
  const absolute = statePath(...parts)
  if (Buffer.byteLength(absolute) <= 100) return absolute
  const near = relative(process.cwd(), absolute)
  if (Buffer.byteLength(near) <= 100) return near
  throw new Error(`The Outpost state directory's path is too long for its sockets: ${absolute}`)
}

/** Replace `path` in one rename, so readers see the old or the new file. */
export function writeFile(path: string, data: string | Uint8Array, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    const descriptor = openSync(temporary, 'wx', mode)
    try {
      writeSync(descriptor, typeof data === 'string' ? Buffer.from(data) : data)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export const writeJson = (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value, null, 1)}\n`)

/** The file's JSON, or `fallback` when it does not exist. */
export function readJson<T>(path: string, fallback: T, limit = 4 * 1024 * 1024): T {
  let raw: Buffer
  try {
    raw = readFileSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
  if (raw.length > limit) throw new Error(`${path} exceeds its size limit.`)
  return JSON.parse(raw.toString('utf8')) as T
}

// SQLite holds an OS lock on this inode for the transaction's lifetime.
// Keep one private file per key so concurrent processes always lock the same inode.
export async function locked<T>(
  name: string,
  action: () => T | Promise<T>,
  timeoutMs = 15_000,
  directory = state.directory,
): Promise<T> {
  const path = join(directory, 'locks', `${name}.lock`)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path, { timeout: 0 })
  try {
    const deadline = performance.now() + timeoutMs
    for (;;) {
      try {
        db.exec('BEGIN EXCLUSIVE')
        break
      } catch (error) {
        // SQLITE_BUSY (5) is the only retryable result. The event loop must
        // remain free for holders in this process to complete their actions.
        if ((error as { errcode?: number }).errcode !== 5) throw error
        const remaining = deadline - performance.now()
        if (remaining <= 0) throw new Error('Outpost is busy on this machine. Try again shortly.', { cause: error })
        await delay(Math.min(remaining, 10))
      }
    }
    chmodSync(path, 0o600)
    return await action()
  } finally {
    db.close()
  }
}

export const now = () => new Date().toISOString()

/** The installed Outpost machine service, which hooks, MCP servers and helpers run as.
 * Tests point it at a launcher for the source tree. */
export const machineExecutable = () => statePath('bin', 'outpost-terminal')
