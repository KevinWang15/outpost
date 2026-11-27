// Antigravity CLI (agy): brain transcripts, SQLite conversation summaries, ACP
// allocation and chat, and one installed Outpost plugin for hooks and MCP.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import type { SessionRecord } from '../../shared/model'
import { shellJoin } from '../../shared/shell'
import { terminalService } from '../../shared/terminalService'
import { withRpc } from '../rpc'
import { locked, machineExecutable, readJson, statePath, writeJson } from '../state'
import { confined, glob, isRecord, lines, timestamp, type Scan } from '../stores'
import { Harness, historyMessage, type Launch, type NativeConversation } from './harness'

const pluginId = 'outpost'
const transcriptNames = ['transcript_full.jsonl', 'transcript.jsonl'] as const

interface SummaryRow {
  id: string
  root: string
  created: string | null
  updated: string | null
  parent: string | null
  subagent: boolean
}

function unwrapUserInput(text: string) {
  const match = /^<USER_REQUEST>\r?\n([\s\S]*?)\r?\n<\/USER_REQUEST>(?:\r?\n<[\s\S]*)?$/.exec(text)
  return match ? match[1] : text
}

function agyTimestamp(value: unknown): string | null {
  if (typeof value === 'string') {
    if (value.startsWith('0001-')) return null
    const goTime = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value.trim())
    if (goTime) {
      const [, date, clock, fraction = '000', zone] = goTime
      return timestamp(`${date}T${clock}.${fraction.slice(0, 3).padEnd(3, '0')}${zone}`)
    }
  }
  const parsed = timestamp(value)
  return parsed && !parsed.startsWith('0001-') ? parsed : null
}

function workspaceRoot(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return ''
  try {
    const uris = JSON.parse(raw)
    if (!Array.isArray(uris)) return ''
    for (const uri of uris) if (typeof uri === 'string' && uri.startsWith('file://')) return fileURLToPath(uri)
  } catch {
    /* Invalid workspace_uris JSON or URI. */
  }
  return ''
}

export class Antigravity extends Harness {
  readonly id = 'antigravity' as const

  private summaries(home: string): Map<string, SummaryRow> {
    const result = new Map<string, SummaryRow>()
    const database = join(home, 'antigravity-cli', 'conversation_summaries.db')
    try {
      if (!existsSync(database) || lstatSync(database).isSymbolicLink()) return result
      if (!realpathSync(database).startsWith(realpathSync(home) + sep)) return result
    } catch {
      return result
    }
    let connection: DatabaseSync | null = null
    try {
      connection = new DatabaseSync(database, { readOnly: true, timeout: 100 })
      const rows = connection
        .prepare(
          'SELECT conversation_id, last_modified_time, workspace_uris, parent_conversation_id, nesting_depth, last_user_input_time FROM conversation_summaries',
        )
        .all() as Record<string, unknown>[]
      for (const row of rows) {
        const id = row.conversation_id
        if (!this.validId(id)) continue
        const parent = this.validId(row.parent_conversation_id) ? row.parent_conversation_id : null
        result.set(id, {
          id,
          root: workspaceRoot(row.workspace_uris),
          created: agyTimestamp(row.last_user_input_time),
          updated: agyTimestamp(row.last_modified_time),
          parent,
          subagent:
            (typeof row.parent_conversation_id === 'string' && row.parent_conversation_id.length > 0) ||
            (typeof row.nesting_depth === 'number' && row.nesting_depth > 0),
        })
      }
    } catch {
      /* Missing table or unreadable SQLite store. */
    } finally {
      connection?.close()
    }
    return result
  }

  private rootId(id: string, summaries: Map<string, SummaryRow>) {
    let current = id
    for (let depth = 0; depth < 16; depth++) {
      const parent = summaries.get(current)?.parent
      if (!parent || parent === current) break
      current = parent
    }
    return current
  }

  private transcriptIn(home: string, conversation: string): string | null {
    if (!this.validId(conversation)) return null
    for (const name of transcriptNames) {
      const candidate = join(home, 'antigravity-cli', 'brain', conversation, '.system_generated', 'logs', name)
      try {
        confined(home, candidate)
        return candidate
      } catch {
        /* Absent or outside the confined store. */
      }
    }
    return null
  }

  private transcriptMetadata(path: string) {
    let root = ''
    let created: string | null = null
    for (const { record } of lines(path)) {
      if (!record) continue
      if (!root && typeof record.cwd === 'string') root = record.cwd
      created ??= agyTimestamp(record.created_at)
      if (root && created) break
    }
    return { root, created }
  }

  private conversation(
    id: string,
    home: string,
    summaries: Map<string, SummaryRow>,
    history: string[],
  ): NativeConversation {
    const summary = summaries.get(id)
    const main = history[0]
    const fromTranscript =
      main && (!summary?.root || !summary.created) ? this.transcriptMetadata(main) : { root: '', created: null }
    let updated = summary?.updated ?? null
    if (!updated && main)
      try {
        updated = timestamp(statSync(main).mtimeMs)
      } catch {
        /* Removed meanwhile. */
      }
    return {
      id,
      root: summary?.root || fromTranscript.root,
      created: fromTranscript.created ?? summary?.created ?? null,
      updated,
      history,
      storage: this.storage(home),
      format: '',
    }
  }

  private hasConversation(session: SessionRecord, conversation: string) {
    const home = this.storeOf(session)
    const database = join(home, 'antigravity-cli', 'conversations', `${conversation}.db`)
    try {
      if (existsSync(database) && !lstatSync(database).isSymbolicLink()) return true
    } catch {
      /* Fall back to transcript check. */
    }
    return this.transcriptIn(home, conversation) !== null
  }

  *discover(environment: Record<string, string>, scan: Scan, cwd?: string) {
    const home = this.home(environment, cwd)
    if (!scan.enterStore(this.id, home)) return
    scan.check()
    scan.files++
    const summaries = this.summaries(home)
    const children = new Map<string, string[]>()
    const roots = new Set<string>()
    for (const [id, row] of summaries) {
      if (!row.subagent) roots.add(id)
      else {
        const owner = this.rootId(id, summaries)
        const list = children.get(owner) ?? []
        list.push(id)
        children.set(owner, list)
      }
    }
    for (const directory of glob(home, 'antigravity-cli/brain/*')) {
      scan.check()
      const id = basename(directory)
      if (!this.validId(id) || summaries.get(id)?.subagent) continue
      if (this.transcriptIn(home, id)) roots.add(id)
    }
    for (const id of roots) {
      scan.check()
      const main = this.transcriptIn(home, id)
      const subagents = (children.get(id) ?? [])
        .map(child => this.transcriptIn(home, child))
        .filter((path): path is string => path !== null)
      const history = [...(main ? [main] : []), ...subagents]
      if (!summaries.has(id) && !history.length) continue
      yield this.conversation(id, home, summaries, history)
    }
  }

  *text(record: Record<string, unknown>) {
    if (record.type === 'USER_INPUT' && typeof record.content === 'string') yield unwrapUserInput(record.content)
    else if (record.type === 'PLANNER_RESPONSE') {
      if (typeof record.content === 'string' && record.content) yield record.content
      if (typeof record.thinking === 'string' && record.thinking) yield record.thinking
    } else if (record.type === 'GENERIC' && record.source === 'MODEL' && typeof record.content === 'string')
      yield record.content
  }

  transcript(session: SessionRecord, conversation: string) {
    return this.transcriptIn(this.storeOf(session), conversation)
  }

  hookPayload(session: SessionRecord, payload: Record<string, unknown>): Record<string, unknown> | null {
    const native = payload.conversationId
    const rawEvent = payload.hookEventName
    if (!this.validId(native) || typeof rawEvent !== 'string') return null
    // Subagents never receive a direct user input step; ignore their hooks.
    if ('hasUserInput' in payload && !payload.hasUserInput) return null
    if (this.summaries(this.storeOf(session)).get(native)?.subagent) return null
    if (rawEvent === 'SessionStart') return { session_id: native, hook_event_name: 'SessionStart' }
    if (rawEvent === 'PreInvocation') return { session_id: native, hook_event_name: 'UserPromptSubmit' }
    return null
  }

  *historyPaths(home: string) {
    for (const directory of glob(home, 'antigravity-cli/brain/*')) {
      const id = basename(directory)
      const path = this.transcriptIn(home, id)
      if (path) yield path
    }
  }

  historySession(path: string, home: string, _scan: Scan, cache: Map<string, unknown>) {
    const parts = relative(home, path).split(sep)
    if (
      parts.length !== 6 ||
      parts[0] !== 'antigravity-cli' ||
      parts[1] !== 'brain' ||
      !this.validId(parts[2]) ||
      parts[3] !== '.system_generated' ||
      parts[4] !== 'logs' ||
      !(transcriptNames as readonly string[]).includes(parts[5])
    )
      throw new Error('Invalid Antigravity history path')
    const key = `antigravity-summaries:${home}`
    let summaries = cache.get(key) as Map<string, SummaryRow> | undefined
    if (!summaries) {
      summaries = this.summaries(home)
      cache.set(key, summaries)
    }
    const owner = this.rootId(parts[2], summaries)
    const main = this.transcriptIn(home, owner)
    return { ...this.conversation(owner, home, summaries, main ? [main] : [path]), history: [path] }
  }

  *historyMessages(record: Record<string, unknown>) {
    const at = agyTimestamp(record.created_at)
    if (record.type === 'USER_INPUT' && typeof record.content === 'string')
      yield historyMessage('user', unwrapUserInput(record.content), at, null)
    else if (record.type === 'PLANNER_RESPONSE' && typeof record.content === 'string' && record.content)
      yield historyMessage('assistant', record.content, at, null)
    else if (
      record.type === 'GENERIC' &&
      record.source === 'MODEL' &&
      typeof record.content === 'string' &&
      record.content
    )
      yield historyMessage('tool', record.content, at, null, 'tool_result')
  }

  async create(root: string, environment: Record<string, string>, executable: string) {
    const home = this.home(environment, root)
    try {
      return await withRpc([executable, 'acp', '--gemini-dir', home], environment, root, async rpc => {
        await rpc.call('initialize', {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'outpost', version: terminalService.version },
        })
        const result = await rpc.call('session/new', { cwd: root, mcpServers: [] })
        if (!this.validId(result.sessionId)) throw new Error('Antigravity CLI returned an invalid session ID')
        await rpc.call('session/close', { sessionId: result.sessionId })
        return result.sessionId
      })
    } catch (error) {
      // Before first sign-in, allow creating a session so the user can authenticate in its terminal.
      if (/Authentication required/i.test((error as Error).message)) return randomUUID()
      throw error
    }
  }

  /** One plugin carries the hooks and Outpost's MCP server. It holds no session
   * identity: each server inherits its Antigravity process's binding, and an
   * ordinary `agy` launch, with no binding, sees no Outpost tools. */
  private async plugin(launch: Launch) {
    const home = this.storeOf(launch.session)
    const root = statePath('integrations', 'antigravity')
    const directory = join(root, pluginId)
    const command = shellJoin(launch.hook)
    const handler = [{ type: 'command', command, timeout: 2 }]
    const manifest = {
      name: pluginId,
      version: '2.0.0',
      description: 'Conversation tracking and Outpost tools for Outpost sessions.',
    }
    const mcpConfig = {
      mcpServers: {
        [launch.outpost.name]: { command: launch.outpost.command, args: launch.outpost.args },
      },
    }
    const hooksConfig = {
      [pluginId]: {
        SessionStart: handler,
        PreInvocation: handler,
      },
    }
    const registry = join(home, 'config', 'plugins.json')
    const key = createHash('sha256').update(home).digest('hex').slice(0, 16)
    await locked(`antigravity-plugins-${key}`, () => {
      let data: unknown = null
      try {
        const raw = readFileSync(registry, 'utf8')
        data = raw.trim() ? JSON.parse(raw) : null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const current = data ?? { entries: [] }
      if (
        !isRecord(current) ||
        (current.entries !== undefined && (!Array.isArray(current.entries) || current.entries.some(e => !isRecord(e))))
      )
        throw new Error('Invalid Antigravity plugin configuration')
      const entries = (current.entries as Record<string, unknown>[] | undefined) ?? []
      const next = entries.some(entry => entry.path === root)
        ? current
        : { ...current, entries: [...entries, { path: root }] }
      for (const [file, value] of [
        [join(directory, 'plugin.json'), manifest],
        [join(directory, 'mcp_config.json'), mcpConfig],
        [join(directory, 'hooks.json'), hooksConfig],
      ] as const)
        if (JSON.stringify(readJson(file, null)) !== JSON.stringify(value)) writeJson(file, value)
      if (JSON.stringify(next) !== JSON.stringify(current) || data === null) writeJson(registry, next)
    })
  }

  async mcp(launch: Launch) {
    await this.plugin(launch)
    return []
  }

  async hooks() {
    return [] // The plugin installed by mcp() carries them.
  }

  settings({ session: { config } }: Launch) {
    return config.model ? ['--model', config.model] : []
  }

  resume(session: SessionRecord, conversation: string) {
    return this.hasConversation(session, conversation) ? ['--conversation', conversation] : []
  }

  chat(executable: string) {
    return { command: [machineExecutable(), 'agent', 'antigravity', executable], env: {} }
  }

  chatResumable(session: SessionRecord, conversation: string) {
    return this.hasConversation(session, conversation)
  }
}
