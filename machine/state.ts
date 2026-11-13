// Outpost's state directory on a machine (~/.outpost) and the primitives every
// writer uses: owner-only atomic files and a cross-process lock.
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Run `action` holding an exclusive lock shared by every Outpost process of
 * this user. The lock file names its holder; a dead holder's lock is broken. */
export async function locked<T>(name: string, action: () => T | Promise<T>, timeoutMs = 15_000): Promise<T> {
  const path = statePath('locks', `${name}.lock`)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const descriptor = openSync(path, 'wx', 0o600)
      writeSync(descriptor, String(process.pid))
      closeSync(descriptor)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let holder: number
      try {
        holder = Number(readFileSync(path, 'utf8'))
      } catch {
        continue // Released between the attempt and the read.
      }
      if (holder > 0 && !alive(holder)) {
        // Break it by renaming, so two breakers cannot both remove a fresh lock.
        const stale = `${path}.${randomUUID()}.stale`
        try {
          renameSync(path, stale)
        } catch {
          continue // Another process broke it first.
        }
        // A fresh lock may have replaced the dead one before the rename: put it back.
        if (readFileSync(stale, 'utf8') !== String(holder))
          try {
            linkSync(stale, path)
          } catch {
            /* Someone holds a newer lock; theirs stands, this one was ours to drop. */
          }
        rmSync(stale, { force: true })
        continue
      }
      if (Date.now() > deadline)
        throw new Error('Outpost is busy on this machine. Try again shortly.', { cause: error })
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  try {
    return await action()
  } finally {
    rmSync(path, { force: true })
  }
}

export const now = () => new Date().toISOString()

/** The installed Outpost Terminal, which hooks, MCP servers and helpers run as.
 * Tests point it at a launcher for the source tree. */
export const machineExecutable = () => process.env.OUTPOST_TERMINAL || statePath('bin', 'outpost-terminal')
