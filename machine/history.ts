// Bounded native-history reads for Outpost's index. Source files are never
// modified; the server owns indexing, embeddings and account boundaries.
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import type { HistoryBatch, HistoryCatalog, HistoryCheckpoint, HistorySource } from '../shared/history'
import type { SessionRecord } from '../shared/model'
import type { Harness } from './harnesses/harness'
import { allHarnesses } from './harnesses'
import { RegistryError } from './registry'
import { clean, confined, decode, maxLine, Scan, SearchLimit } from './stores'

const maxText = 1024 * 1024
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

/** Every native store a session (or the default environment) points at. */
function roots(sessions: SessionRecord[]) {
  const found = new Map<string, { adapter: Harness; home: string }>()
  const scopes: { env: Record<string, string>; cwd?: string }[] = [{ env: process.env as Record<string, string> }]
  for (const session of sessions)
    scopes.push({
      env: { ...(process.env as Record<string, string>), ...session.config.env, ...session.storage },
      cwd: session.rootDir,
    })
  for (const { env, cwd } of scopes)
    for (const adapter of allHarnesses()) {
      const home = adapter.home(env, cwd)
      found.set(`${adapter.id}\0${home}`, { adapter, home })
    }
  return found
}

/** A readable history source: the file itself, or its decoded content. */
function open(adapter: Harness, path: string) {
  if (adapter.historyBytes) {
    const decoded = adapter.historyBytes(path)
    return {
      size: decoded.data.length,
      sourceSize: decoded.sourceSize,
      modified: decoded.modified,
      incomplete: decoded.incomplete,
      read: (position: number, length: number) => decoded.data.subarray(position, position + length),
      close() {},
    }
  }
  const info = statSync(path)
  const descriptor = openSync(path, 'r')
  return {
    size: info.size,
    sourceSize: info.size,
    modified: statSync(path, { bigint: true }).mtimeNs.toString(),
    incomplete: false,
    read(position: number, length: number) {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, info.size - position)))
      readSync(descriptor, buffer, 0, buffer.length, position)
      return buffer
    },
    close: () => closeSync(descriptor),
  }
}

function describe(
  adapter: Harness,
  home: string,
  path: string,
  scan: Scan,
  cache: Map<string, unknown>,
): HistorySource {
  confined(home, path)
  const conversation = adapter.historySession(path, home, scan, cache)
  const info = statSync(path)
  return {
    id: digest(`${adapter.id}\0${home}\0${path}`),
    tool: adapter.id,
    nativeId: conversation.id,
    home,
    path,
    title: clean(conversation.title, 200),
    cwd: conversation.root,
    forkedFrom: conversation.forkedFrom ?? null,
    size: info.size,
    modified: statSync(path, { bigint: true }).mtimeNs.toString(),
    format: conversation.format,
  }
}

/** Attribute a source to the Outpost session whose timeline holds it. */
function managed(sessions: SessionRecord[], source: HistorySource) {
  const owner = sessions.find(
    session =>
      session.tool === source.tool &&
      Object.values(session.storage).includes(source.home) &&
      session.conversations.some(item => item.id === source.nativeId && !item.movedTo),
  )
  if (owner) Object.assign(source, { nativeTitle: source.title, title: owner.name, managedSessionId: owner.id })
  return source
}

export function catalog(sessions: SessionRecord[], after: unknown, limit: unknown = 100): HistoryCatalog {
  if (after !== null && after !== undefined && (typeof after !== 'string' || after.length > 8192))
    throw new RegistryError('Invalid history catalog cursor', 400)
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new RegistryError('Invalid history catalog limit', 400)
  const candidates: { key: string; adapter: Harness; home: string; path: string }[] = []
  for (const { adapter, home } of roots(sessions).values())
    for (const path of adapter.historyPaths(home)) {
      const key = `${adapter.id}\0${home}\0${path}`
      if (!after || key > after) candidates.push({ key, adapter, home, path })
    }
  candidates.sort((a, b) => (a.key < b.key ? -1 : 1))
  const scan = new Scan(15, 32 * 1024 * 1024)
  const cache = new Map<string, unknown>()
  const sources: HistorySource[] = []
  const warnings: string[] = []
  let last: string | null = null
  const page = candidates.slice(0, limit)
  for (const { key, adapter, home, path } of page) {
    try {
      sources.push(managed(sessions, describe(adapter, home, path, scan, cache)))
    } catch (error) {
      if (error instanceof SearchLimit) {
        warnings.push('History metadata scan reached its limit; the next refresh continues this page.')
        break
      }
      warnings.push('An unreadable or invalid native history source was skipped.')
    }
    last = key
  }
  return {
    sources,
    next: last !== null && (candidates.length > limit || sources.length < page.length) ? last : null,
    warnings: [...new Set(warnings)].slice(0, 10),
  }
}

function sourceFor(value: unknown, allowed: ReturnType<typeof roots>, scan: Scan, cache: Map<string, unknown>) {
  const source = value as HistorySource | null
  const root = source && allowed.get(`${source.tool}\0${source.home}`)
  if (!root || typeof source.path !== 'string') throw new Error('History source is outside the configured stores')
  return {
    adapter: root.adapter,
    path: source.path,
    source: describe(root.adapter, root.home, source.path, scan, cache),
  }
}

function fingerprint(read: (position: number, length: number) => Buffer, offset: number) {
  const prefixSize = Math.min(offset, 4096)
  const tailSize = Math.min(offset, 256)
  return {
    prefix: digest(read(0, prefixSize)),
    prefixSize,
    tail: digest(read(offset - tailSize, tailSize)),
    tailSize,
  }
}

export function readBatch(sessions: SessionRecord[], sources: unknown): HistoryBatch {
  if (!Array.isArray(sources) || sources.length > 100)
    throw new RegistryError('Provide at most 100 history sources', 400)
  const allowed = roots(sessions)
  const scan = new Scan(15)
  const cache = new Map<string, unknown>()
  const files: HistoryBatch['files'] = []
  const warnings: string[] = []
  let total = 0
  const deadline = performance.now() + 12_000
  for (const item of sources as { source: unknown; checkpoint: HistoryCheckpoint | null }[]) {
    if (total >= 8 * 1024 * 1024 || performance.now() >= deadline) break
    try {
      const { adapter, path, source } = sourceFor(item.source, allowed, scan, cache)
      managed(sessions, source)
      const previous = item.checkpoint
      let offset = previous?.offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid history checkpoint')
      const reader = open(adapter, path)
      try {
        source.size = reader.size
        source.modified = reader.modified
        let reset = !previous || offset > reader.size
        if (previous && !reset) {
          const now = fingerprint(reader.read, offset)
          reset = now.prefix !== previous.prefix || now.tail !== previous.tail
          if (reader.size === previous.size && reader.modified !== previous.modified && !reader.incomplete) reset = true
        }
        if (reset) offset = 0
        const generation = reset || !previous ? randomUUID().replace(/-/g, '') : previous.generation
        const messages: HistoryBatch['files'][number]['messages'] = []
        // Without the tool's own ID, a message's identity follows from it and the one before.
        let last = reset ? null : (previous?.identity ?? null)
        const identity = (message: { identity: string | null; role: string; kind: string; text: string }) =>
          (last = message.identity
            ? `${adapter.id}:${message.identity}`
            : digest(`${source.nativeId}\0${last ?? ''}\0${message.role}\0${message.kind}\0${message.text}`).slice(
                0,
                40,
              ))
        let position = offset
        // A window of the file from `position`, read in blocks as lines need it.
        let window = Buffer.alloc(0)
        let windowStart = position
        // Complete lines only; a trailing record still being written waits for its append.
        while (position < reader.size && total < 8 * 1024 * 1024 && performance.now() < deadline) {
          let newline = window.indexOf(10, position - windowStart)
          while (newline < 0 && window.length - (position - windowStart) <= maxLine) {
            const more = reader.read(windowStart + window.length, 1024 * 1024)
            if (!more.length) break
            window = Buffer.concat([window.subarray(position - windowStart), more])
            windowStart = position
            newline = window.indexOf(10)
          }
          if (newline < 0) {
            if (window.length - (position - windowStart) <= maxLine) break // Still being written.
            warnings.push('An oversized native history record was skipped.')
            // Skip to the end of the oversized record.
            let skip = windowStart + window.length
            for (;;) {
              const more = reader.read(skip, 1024 * 1024)
              if (!more.length) break
              const at = more.indexOf(10)
              if (at >= 0) {
                skip += at + 1
                break
              }
              skip += more.length
            }
            position = skip
            offset = position
            window = Buffer.alloc(0)
            windowStart = position
            continue
          }
          const line = window.subarray(position - windowStart, newline)
          const start = position
          total += newline - (position - windowStart) + 1
          position = windowStart + newline + 1
          offset = position
          const record = decode(line)
          if (!record) continue
          try {
            for (const message of adapter.historyMessages(record, source.format ?? '')) {
              if (!message.text.trim()) continue
              if (message.text.length > maxText)
                warnings.push(
                  'A very large message was indexed as a prefix; read_message can fetch the remainder while this machine is online.',
                )
              messages.push({
                ...message,
                identity: identity(message),
                position: start,
                text: message.text.slice(0, maxText),
                truncated: message.text.length > maxText,
                totalChars: message.text.length,
                contentHash: digest(message.text),
              })
            }
          } catch {
            warnings.push('An invalid native history record was skipped.')
          }
        }
        files.push({
          source,
          checkpoint: {
            offset,
            size: reader.size,
            sourceSize: reader.sourceSize,
            modified: reader.modified,
            generation,
            ...fingerprint(reader.read, offset),
            identity: last,
          },
          reset,
          messages,
          pending: offset < reader.size,
        })
      } finally {
        reader.close()
      }
    } catch (error) {
      if (error instanceof SearchLimit) {
        warnings.push('History reading reached its metadata limit; refresh again to continue.')
        break
      }
      warnings.push((error as Error).message.slice(0, 200))
    }
  }
  return { files, warnings: [...new Set(warnings)].slice(0, 10) }
}

export function readMessage(sessions: SessionRecord[], request: Record<string, unknown>) {
  const { adapter, path, source } = sourceFor(request.source, roots(sessions), new Scan(5), new Map())
  const position = request.position
  const offset = request.offset ?? 0
  const limit = request.limit ?? 8000
  if (
    [position, offset, limit].some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) ||
    (limit as number) < 1 ||
    (limit as number) > 20_000
  )
    throw new RegistryError('Invalid history message page', 400)
  const reader = open(adapter, path)
  let line: Buffer
  try {
    const chunk = reader.read(position as number, maxLine + 1)
    const end = chunk.indexOf(10)
    if (end < 0) throw new RegistryError('This native history record exceeds the read limit')
    line = chunk.subarray(0, end)
  } finally {
    reader.close()
  }
  const record = decode(line)
  for (const entry of record ? adapter.historyMessages(record, source.format ?? '') : []) {
    if (digest(entry.text) !== request.contentHash) continue
    const end = Math.min(entry.text.length, (offset as number) + (limit as number))
    return {
      text: entry.text.slice(offset as number, end),
      totalChars: entry.text.length,
      nextOffset: end < entry.text.length ? end : null,
    }
  }
  throw new RegistryError('The native message changed. Refresh the history index and search again.')
}
