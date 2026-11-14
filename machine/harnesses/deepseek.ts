// DeepSeek Harness (dsh): ACP chat only, with versioned and optionally
// Zstandard-compressed JSONL history generations.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { SessionRecord } from '../../shared/model'
import { machineExecutable } from '../state'
import { withRpc } from '../rpc'
import { clean, decode, glob, isRecord, promptTitle, strings, timestamp, type Scan } from '../stores'
import { Harness, historyMessage, type NativeActivity, type NativeConversation } from './harness'

const generation = /^session(?:\.v([0-9]+))?\.jsonl(?:\.zstd)?$/
const maxDecoded = 256 * 1024 * 1024
const roles: Record<string, 'user' | 'assistant' | 'tool'> = {
  'user/message': 'user',
  'steering/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
}
const turnEnds: Record<string, NativeActivity['state']> = {
  completed: 'finished',
  error: 'error',
  failed: 'error',
  cancelled: 'idle',
  aborted: 'idle',
}

/** End of the complete Zstandard frame at `start`, or null for a torn tail. */
function frameEnd(input: Buffer, start: number) {
  let p = start
  const take = (n: number) => {
    if (p + n > input.length) throw torn
    const at = p
    p += n
    return at
  }
  if (input.readUInt32LE(take(4)) !== 0xfd2fb528) throw new Error('Invalid Zstandard frame')
  const flags = input[take(1)]
  const single = Boolean(flags & 32)
  const content = flags >>> 6
  const dictionary = flags & 3
  if (flags & 24) throw new Error('Reserved Zstandard frame flags')
  take((single ? 0 : 1) + (dictionary === 3 ? 4 : dictionary) + (content === 0 ? (single ? 1 : 0) : 2 ** content))
  for (;;) {
    const block = input.readUIntLE(take(3), 3)
    const kind = (block >>> 1) & 3
    if (kind === 3) throw new Error('Reserved Zstandard block kind')
    take(kind === 1 ? 1 : block >>> 3)
    if (block & 1) break
  }
  if (flags & 4) take(4)
  return p
}
const torn = new Error('torn')

/** Decode complete frames only; a frame still being written is left for later. */
function decodeHistory(path: string) {
  const input = readFileSync(path)
  if (input.length > maxDecoded) throw new Error('Compressed DeepSeek history exceeds its limit.')
  const parts: Buffer[] = []
  let size = 0
  let offset = 0
  let incomplete = false
  while (offset < input.length) {
    let end
    try {
      end = frameEnd(input, offset)
    } catch (error) {
      if (error === torn && offset > 0) {
        incomplete = true
        break
      }
      throw error === torn ? new Error('Incomplete DeepSeek history') : error
    }
    const decoded = zstdDecompressSync(input.subarray(offset, end), { maxOutputLength: maxDecoded - size })
    parts.push(decoded)
    size += decoded.length
    offset = end
  }
  return { data: Buffer.concat(parts), incomplete }
}

export class DeepSeek extends Harness {
  readonly id = 'deepseek' as const
  readonly selectionOptions = [
    '--resume',
    '--session',
    '--session-id',
    '--profile',
    '--from-default-profile',
    '--patch',
  ]

  /** The newest generation of each session directory; older ones repeat it. */
  private *generations(home: string) {
    for (const directory of glob(home, 'sessions/*/*')) {
      let best: { version: number; mtime: number; path: string } | null = null
      let names: string[]
      try {
        names = readdirSync(directory)
      } catch {
        continue
      }
      for (const name of names) {
        const match = generation.exec(name)
        if (!match) continue
        const path = join(directory, name)
        const candidate = { version: Number(match[1] ?? 0), mtime: statSync(path).mtimeMs, path }
        if (
          !best ||
          candidate.version > best.version ||
          (candidate.version === best.version && candidate.mtime > best.mtime)
        )
          best = candidate
      }
      if (best) yield best.path
    }
  }

  historyBytes(path: string) {
    const info = statSync(path)
    const decoded = path.endsWith('.zstd') ? decodeHistory(path) : { data: readFileSync(path), incomplete: false }
    return { ...decoded, sourceSize: info.size, modified: statSync(path, { bigint: true }).mtimeNs.toString() }
  }

  private rows(path: string) {
    const { data } = this.historyBytes(path)
    return data
      .toString('utf8')
      .split('\n')
      .map(line => decode(line))
      .filter(row => row !== null)
  }

  private metadata(path: string) {
    const rows = this.rows(path)
    const header = rows[0]
    if (!header || header.type !== 'session') throw new Error('Invalid DeepSeek session header')
    const version = header.version
    if (
      !this.validId(header.id) ||
      typeof version !== 'number' ||
      !Number.isInteger(version) ||
      version < 0 ||
      version > 4
    )
      throw new Error('Unsupported DeepSeek session identity or history format')
    let title = header.id
    for (const row of rows.slice(1)) {
      const data = row.data
      if (!isRecord(data)) continue
      if (row.type === 'session/title' && typeof data.title === 'string') title = data.title
      else if (title === header.id && row.type === 'user/message') title = promptTitle([...this.text(row)][0]) || title
    }
    return { header, title: clean(title, 160) }
  }

  private conversation(path: string, home: string): NativeConversation {
    const { header, title } = this.metadata(path)
    return {
      id: header.id as string,
      root: typeof header.cwd === 'string' ? header.cwd : '',
      title,
      created: timestamp(header.createdAt),
      updated: timestamp(statSync(path).mtimeMs),
      history: [path],
      storage: this.storage(home),
      format: String(header.version),
    }
  }

  *discover(environment: Record<string, string>, scan: Scan, cwd?: string) {
    const home = this.home(environment, cwd)
    if (!scan.enterStore(this.id, home)) return
    for (const path of this.generations(home)) {
      scan.check()
      scan.files++
      try {
        // Subagents stay searchable, but ACP resumes root sessions only.
        if (this.metadata(path).header.origin !== 'subagent') yield this.conversation(path, home)
      } catch {
        scan.skipped++
      }
    }
  }

  *text(record: Record<string, unknown>) {
    for (const message of this.historyMessages(record)) yield message.text
  }

  transcript(session: SessionRecord, conversation: string) {
    for (const path of this.generations(this.storeOf(session))) if (path.split(sep).at(-2) === conversation) return path
    return null
  }

  title(session: SessionRecord, conversation: string) {
    const path = this.transcript(session, conversation)
    return path ? this.metadata(path).title : null
  }

  activity(record: Record<string, unknown>): NativeActivity | null {
    const data = isRecord(record.data) ? record.data : {}
    const at = record.time
    const turn = data.turn !== undefined && data.turn !== '' ? String(data.turn) : null
    if (record.type === 'turn/start') return { state: 'working', timestamp: at, turn }
    if (record.type === 'turn/end') {
      const reason = isRecord(data.reason) ? data.reason.kind : data.reason
      return { state: turnEnds[reason as string] ?? 'idle', timestamp: at, turn }
    }
    if (record.type === 'approval/asked') return { state: 'waiting', timestamp: at, turn }
    if (record.type === 'approval/decided') return { state: 'working', timestamp: at, turn }
    return null
  }

  *historyPaths(home: string) {
    yield* this.generations(home)
  }

  historySession(path: string, home: string) {
    const parts = relative(home, path).split(sep)
    if (parts.length !== 4 || parts[0] !== 'sessions' || !generation.test(parts[3]))
      throw new Error('Invalid DeepSeek history path')
    return this.conversation(path, home)
  }

  *historyMessages(record: Record<string, unknown>) {
    const role = roles[record.type as string]
    const data = record.data
    if (!role || !isRecord(data)) return
    const entry = isRecord(data.message) ? data.message : data
    // Only committed messages; deltas, attempts, credentials and prompts are absent.
    yield historyMessage(
      role,
      [...strings(entry.content)].join('\n'),
      timestamp(record.time),
      'turn' in data ? String(data.turn) : null,
    )
  }

  async create(root: string, environment: Record<string, string>, executable: string) {
    return withRpc([executable, '--profile', 'acp'], environment, root, async rpc => {
      await rpc.call('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'outpost', version: '1' },
      })
      const result = await rpc.call('session/new', { cwd: root, mcpServers: [] })
      if (!this.validId(result.sessionId)) throw new Error('DeepSeek returned an invalid session ID')
      await rpc.call('session/close', { sessionId: result.sessionId })
      return result.sessionId
    })
  }

  async mcp() {
    return []
  }
  async hooks() {
    return []
  }
  settings() {
    return []
  }
  resume(): string[] {
    throw new Error('DeepSeek Harness has no terminal interface. Open this session in Outpost Chat.')
  }

  chat(executable: string) {
    // A small transport maps its session/resume to the session/load chat uses.
    return { command: [machineExecutable(), 'agent', 'deepseek', executable], env: {} }
  }
}
