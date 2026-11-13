// Bounded, read-only access to coding tools' native stores: JSONL records,
// JSON documents, path patterns and conversation text. Nothing here writes.
import { closeSync, lstatSync, openSync, readSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export class SearchLimit extends Error {}

/** One request's budget across every store it reads. */
export class Scan {
  readonly deadline: number
  bytesLeft: number
  skipped = 0
  files = 0
  private stores = new Set<string>()
  constructor(seconds = 12, bytes = 256 * 1024 * 1024) {
    this.deadline = performance.now() + seconds * 1000
    this.bytesLeft = bytes
  }
  /** Scan a canonical store once per request, even when several sessions share it. */
  enterStore(tool: string, home: string) {
    const key = `${tool}\0${home}`
    if (this.stores.has(key)) return false
    this.stores.add(key)
    return true
  }
  check() {
    if (performance.now() >= this.deadline || this.bytesLeft < 0 || this.files > 20_000) throw new SearchLimit()
  }
  /** JSON objects, one per line. Torn, oversized or invalid lines are skipped. */
  *records(path: string): Generator<Record<string, unknown>> {
    this.check()
    this.files++
    if (!regularFile(path)) return
    let complete = 0
    for (const { record, line, end } of lines(path)) {
      this.check()
      this.bytesLeft -= line
      this.check()
      complete = end
      if (record) yield record
      else this.skipped++
    }
    // A torn final line: the tool is writing it, or it never finished.
    if (fileSize(path) > complete) this.skipped++
  }
  /** JSON objects in a file the tool encodes (decoded by its adapter), one per line. */
  *decodedRecords(path: string, read: (path: string) => { data: Buffer }): Generator<Record<string, unknown>> {
    this.check()
    this.files++
    if (!regularFile(path)) return
    let data: Buffer
    try {
      data = read(path).data
    } catch {
      this.skipped++
      return
    }
    this.bytesLeft -= data.length
    this.check()
    for (let start = 0; start < data.length;) {
      let end = data.indexOf(10, start)
      if (end < 0) end = data.length
      const line = data.subarray(start, end)
      start = end + 1
      if (!line.length) continue
      const record = line.length > maxLine ? null : decode(line)
      if (record) yield record
      else this.skipped++
    }
  }
  /** A JSON object document, or {} when missing or invalid. */
  document(path: string): Record<string, unknown> {
    this.check()
    this.files++
    if (!regularFile(path)) return {}
    try {
      const raw = readFileSync(path)
      this.bytesLeft -= raw.length
      this.check()
      if (raw.length > maxLine) return (this.skipped++, {})
      const value = JSON.parse(raw.toString('utf8'))
      return isRecord(value) ? value : {}
    } catch (error) {
      if (error instanceof SearchLimit) throw error
      this.skipped++
      return {}
    }
  }
}

export const maxLine = 8 * 1024 * 1024
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const fileSize = (path: string) => {
  try {
    return lstatSync(path).size
  } catch {
    return 0
  }
}

function regularFile(path: string) {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

/** Every complete line of a file, decoded when it is a JSON object. Reads in
 * blocks; a line longer than `maxLine` is skipped without holding it. */
export function* lines(
  path: string,
  start = 0,
): Generator<{ record: Record<string, unknown> | null; line: number; end: number }> {
  let descriptor: number
  try {
    descriptor = openSync(path, 'r')
  } catch {
    return
  }
  try {
    const block = Buffer.alloc(1024 * 1024)
    let pending: Buffer[] = []
    let pendingSize = 0
    let oversized = false
    let position = start
    let offset = start
    for (;;) {
      const read = readSync(descriptor, block, 0, block.length, position)
      if (!read) return
      position += read
      let from = 0
      for (;;) {
        const newline = block.indexOf(10, from)
        if (newline < 0 || newline >= read) break
        const piece = block.subarray(from, newline)
        offset += pendingSize + piece.length + 1
        if (!oversized && pendingSize + piece.length <= maxLine) {
          const line = pendingSize ? Buffer.concat([...pending, piece]) : piece
          yield { record: decode(line), line: line.length + 1, end: offset }
        } else yield { record: null, line: pendingSize + piece.length + 1, end: offset }
        pending = []
        pendingSize = 0
        oversized = false
        from = newline + 1
      }
      const rest = block.subarray(from, read)
      pendingSize += rest.length
      if (pendingSize > maxLine) oversized = true
      if (!oversized) pending.push(Buffer.from(rest))
      else pending = []
    }
  } finally {
    closeSync(descriptor)
  }
}

export function decode(line: Buffer | string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(typeof line === 'string' ? line : line.toString('utf8'))
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

/** Collapse whitespace and drop control characters. */
export function clean(value: unknown, limit = 280) {
  if (typeof value !== 'string') return ''
  return [...value.replace(/\s+/g, ' ')]
    .filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join('')
    .trim()
    .slice(0, limit)
}

/** ISO 8601 in UTC, from ISO text or epoch seconds/milliseconds; null when invalid. */
export function timestamp(value: unknown): string | null {
  let time: number
  if (typeof value === 'number' && Number.isFinite(value)) time = value > 1e11 ? value : value * 1000
  else if (typeof value === 'string' && value) time = Date.parse(value)
  else return null
  if (!Number.isFinite(time)) return null
  const date = new Date(time)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const metadataKeys = new Set([
  'type',
  'role',
  'id',
  'uuid',
  'timestamp',
  'time',
  'mime_type',
  'mimeType',
  'image_url',
  'image',
  'source',
  'blob',
  'blobId',
  'signature',
  'encrypted_content',
  'sessionId',
  'session_id',
  'agentId',
  'toolCallId',
  'parent_tool_use_id',
  'call_id',
  'cwd',
  'workDir',
  'createdAt',
  'updatedAt',
])
const binaryTypes = new Set(['image', 'image_url', 'input_image', 'base64', 'audio', 'input_audio'])

/** Conversation text in a native value; never inline image data or protocol metadata. */
export function* strings(value: unknown, depth = 0): Generator<string> {
  if (depth > 100) return
  if (typeof value === 'string') {
    if (!value.startsWith('data:')) yield value
  } else if (Array.isArray(value)) for (const item of value) yield* strings(item, depth + 1)
  else if (isRecord(value)) {
    if (binaryTypes.has(value.type as string)) return
    for (const [key, item] of Object.entries(value)) if (!metadataKeys.has(key)) yield* strings(item, depth + 1)
  }
}

/** Paths below `root` matching `pattern` ('*' within a name, '**' for any
 * depth). Symlinks are never followed and results stay inside `within`. */
export function* glob(root: string, pattern: string, within = root): Generator<string> {
  let base: string
  try {
    base = realpathSync(within)
  } catch {
    return
  }
  const parts = pattern.split('/')
  const matcher = (part: string) =>
    new RegExp(
      `^${part
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')}$`,
    )
  function* walk(directory: string, index: number): Generator<string> {
    if (index === parts.length) return
    const part = parts[index]
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1))
    if (part === '**') {
      yield* walk(directory, index + 1)
      for (const entry of entries) if (entry.isDirectory()) yield* walk(join(directory, entry.name), index)
      return
    }
    const match = matcher(part)
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !match.test(entry.name)) continue
      const path = join(directory, entry.name)
      if (index === parts.length - 1) yield path
      else if (entry.isDirectory()) yield* walk(path, index + 1)
    }
  }
  for (const path of walk(root, 0)) {
    try {
      const real = realpathSync(path)
      if (real === base || real.startsWith(base + sep)) yield path
    } catch {
      /* Removed during the walk. */
    }
  }
}

/** A store path relative to its home, rejecting symlinks on the way. */
export function confined(home: string, path: string) {
  const parts = relative(home, path).split(sep)
  if (!parts.length || parts[0] === '..' || parts.includes('..'))
    throw new Error('History source is outside its store.')
  let current = home
  for (const part of parts) {
    current = join(current, part)
    if (lstatSync(current).isSymbolicLink()) throw new Error('History symlinks are not followed.')
  }
  if (!lstatSync(path).isFile()) throw new Error('History source is no longer available.')
  return parts
}

interface Fold<T> {
  identity: string
  end: number
  value: T
}
const folds = new Map<string, Fold<unknown>>()

/** Fold a growing JSONL file, reading only what was appended since the last
 * call. A replaced or truncated file is folded again from the start. */
export function foldLines<T>(
  key: string,
  path: string,
  initial: () => T,
  fold: (value: T, record: Record<string, unknown>, end: number) => T,
): T {
  let info
  try {
    info = lstatSync(path)
  } catch {
    folds.delete(key)
    return initial()
  }
  const identity = `${info.dev}:${info.ino}`
  let entry = folds.get(key) as Fold<T> | undefined
  if (!entry || entry.identity !== identity || entry.end > info.size) entry = { identity, end: 0, value: initial() }
  for (const { record, end } of lines(path, entry.end)) {
    if (record) entry.value = fold(entry.value, record, end)
    entry.end = end
  }
  folds.set(key, entry)
  if (folds.size > 4096) folds.delete(folds.keys().next().value!)
  return entry.value
}

/** Complete records newest first, ending at `end`, with each record's end
 * offset. A torn final record is skipped, as is any line over `maxLine`. */
export function* reverseRecords(
  path: string,
  end: number,
): Generator<{ record: Record<string, unknown>; offset: number }> {
  let descriptor: number
  try {
    descriptor = openSync(path, 'r')
  } catch {
    return
  }
  try {
    const block = Buffer.alloc(64 * 1024)
    let position = end
    // Until the last newline is found, bytes belong to a torn record.
    let torn = true
    let lineEnd = end
    let pieces: Buffer[] = []
    let size = 0
    const collect = (piece: Buffer) => {
      size += piece.length
      if (size > maxLine) pieces = []
      else if (piece.length) pieces.unshift(Buffer.from(piece))
    }
    const take = () => {
      const record = size && size <= maxLine ? decode(Buffer.concat(pieces)) : null
      pieces = []
      size = 0
      return record
    }
    while (position > 0) {
      const length = Math.min(block.length, position)
      position -= length
      readSync(descriptor, block, 0, length, position)
      let to = length
      while (to > 0) {
        const newline = block.lastIndexOf(10, to - 1)
        if (newline < 0) {
          if (!torn) collect(block.subarray(0, to))
          break
        }
        if (torn) torn = false
        else {
          collect(block.subarray(newline + 1, to))
          const record = take()
          if (record) yield { record, offset: lineEnd }
        }
        lineEnd = position + newline + 1
        to = newline
      }
    }
    // The file's first line.
    const record = torn ? null : take()
    if (record) yield { record, offset: lineEnd }
  } finally {
    closeSync(descriptor)
  }
}
