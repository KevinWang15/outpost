// The machine's event log: what its sessions' drivers did, in the order they
// did it. Terminal services and chat hosts append; the node reads it for
// Outpost by cursor, so changes while Outpost is away arrive when it returns.
// One line per event, appended in a single write; the file rotates once.
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'node:fs'
import type { MachineEvent, MachineEvents } from '../shared/machine'
import { statePath } from './state'

type Unstamped<T> = T extends unknown ? Omit<T, 'at'> : never

const rotateBytes = 4 * 1024 * 1024
const readBytes = 1024 * 1024
const directory = () => statePath('events')
const current = () => statePath('events', 'events.ndjson')
const rotated = () => statePath('events', 'events.1.ndjson')

export const eventsDirectory = directory

/** Record an event. Never throws: the log must not stop a session. */
export function recordEvent(event: Unstamped<MachineEvent>) {
  try {
    mkdirSync(directory(), { recursive: true, mode: 0o700 })
    appendFileSync(current(), `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`, { mode: 0o600 })
    if (statSync(current()).size > rotateBytes) renameSync(current(), rotated())
  } catch {
    /* A full or read-only disk loses the record, not the session. */
  }
}

interface File {
  path: string
  inode: number
  size: number
}
function file(path: string): File | null {
  try {
    const info = statSync(path)
    return { path, inode: info.ino, size: info.size }
  } catch {
    return null
  }
}
const cursorOf = (inode: number, offset: number) => `${inode}:${offset}`

/** Complete lines of `file` from `offset`, at most `readBytes`. */
function lines(source: File, offset: number) {
  const length = Math.max(0, Math.min(source.size - offset, readBytes))
  const buffer = Buffer.alloc(length)
  const descriptor = openSync(source.path, 'r')
  try {
    readSync(descriptor, buffer, 0, length, offset)
  } finally {
    closeSync(descriptor)
  }
  // A full window without a line end is not an event: skip it, and the next read
  // drops the rest of that line as damaged.
  const end = buffer.lastIndexOf(10) + 1 || (length === readBytes ? length : 0)
  const events: MachineEvent[] = []
  for (const line of buffer.subarray(0, end).toString('utf8').split('\n'))
    if (line)
      try {
        events.push(JSON.parse(line))
      } catch {
        /* A damaged line is skipped. */
      }
  return { events, next: offset + end, done: offset + end >= source.size }
}

/** Events after `after`. Without a cursor, reading starts at the end: what
 * happened before Outpost first looked is not replayed. */
export function readEvents(after: unknown): MachineEvents {
  const now = file(current())
  const old = file(rotated())
  const match = typeof after === 'string' ? /^(\d+):(\d+)$/.exec(after) : null
  if (!match) return { events: [], cursor: now ? cursorOf(now.inode, now.size) : cursorOf(0, 0), more: false }
  const inode = Number(match[1]),
    offset = Number(match[2])
  if (now && inode === now.inode && offset <= now.size) {
    const read = lines(now, offset)
    return { events: read.events, cursor: cursorOf(now.inode, read.next), more: !read.done }
  }
  // The log rotated since: finish the old file, then continue in the new one.
  if (old && inode === old.inode && offset <= old.size) {
    const read = lines(old, offset)
    if (!read.done || !now) return { events: read.events, cursor: cursorOf(old.inode, read.next), more: !read.done }
    const rest = lines(now, 0)
    return { events: [...read.events, ...rest.events], cursor: cursorOf(now.inode, rest.next), more: !rest.done }
  }
  if (!now) return { events: [], cursor: after as string, more: false }
  // Lost track (rotated twice, or first recorded since): what the log holds now.
  const read = lines(now, 0)
  return { events: read.events, cursor: cursorOf(now.inode, read.next), more: !read.done }
}
