// DeepSeek Harness (dsh): ACP chat only, with versioned and optionally
// Zstandard-compressed JSONL history generations.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { SessionRecord } from '../../shared/model'
import { terminalService } from '../../shared/terminalService'
import { machineExecutable } from '../state'
import { withRpc } from '../rpc'
import { decode, glob, isRecord, lines, strings, timestamp, type Scan } from '../stores'
import { Harness, historyMessage, type NativeConversation } from './harness'

const generation = /^session(?:\.v([0-9]+))?\.jsonl(?:\.zstd)?$/
const maxDecoded = 256 * 1024 * 1024
const roles: Record<string, 'user' | 'assistant' | 'tool'> = {
  'user/message': 'user',
  'steering/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
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
function decodeHistory(path: string, firstLineOnly = false) {
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
    if (firstLineOnly && decoded.includes(10)) break
  }
  return { data: Buffer.concat(parts), incomplete }
}

export class DeepSeek extends Harness {
  readonly id = 'deepseek' as const

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
    const info = statSync(path, { bigint: true })
    const decoded = path.endsWith('.zstd') ? decodeHistory(path) : { data: readFileSync(path), incomplete: false }
    return { ...decoded, sourceSize: Number(info.size), modified: info.mtimeNs.toString() }
  }

  private metadata(path: string): Record<string, unknown> {
    let header: Record<string, unknown> | null = null
    if (path.endsWith('.zstd')) {
      const { data } = decodeHistory(path, true)
      const newline = data.indexOf(10)
      header = decode(newline >= 0 ? data.subarray(0, newline) : data)
    } else {
      for (const { record } of lines(path)) {
        header = record
        break
      }
    }
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
    return header
  }

  private conversation(path: string, home: string, header: Record<string, unknown>): NativeConversation {
    return {
      id: header.id as string,
      root: typeof header.cwd === 'string' ? header.cwd : '',
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
        const header = this.metadata(path)
        // Subagents stay searchable, but ACP resumes root sessions only.
        if (header.origin !== 'subagent') yield this.conversation(path, home, header)
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

  *historyPaths(home: string) {
    yield* this.generations(home)
  }

  historySession(path: string, home: string) {
    const parts = relative(home, path).split(sep)
    if (parts.length !== 4 || parts[0] !== 'sessions' || !generation.test(parts[3]))
      throw new Error('Invalid DeepSeek history path')
    return this.conversation(path, home, this.metadata(path))
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
        clientInfo: { name: 'outpost', version: terminalService.version },
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
