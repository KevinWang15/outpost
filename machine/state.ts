// Outpost's state directory on a machine (~/.outpost) and the primitives every
// writer uses: owner-only atomic files and a cross-process lock.
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

/** `~/.outpost` of the user Outpost runs as; every path below derives from it.
 * Commands run inside a session use their binding's directory instead
 * (`useBinding`), and tests point it elsewhere. */
export const state = { directory: join(homedir(), '.outpost') }

/** For commands a coding tool runs: the state directory the launch bound. */
export function useBinding() {
  const directory = process.env.OUTPOST_STATE_DIRECTORY
  if (directory?.startsWith('/')) state.directory = directory
}
export const statePath = (...parts: string[]) => join(state.directory, ...parts)

/** Work in the state directory (created on first use). */
export function enterState() {
  mkdirSync(state.directory, { recursive: true, mode: 0o700 })
  process.chdir(state.directory)
}

/** Replace `path` in one rename, so readers see the old or the new file. */
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
