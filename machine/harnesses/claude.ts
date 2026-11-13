// Claude Code: project transcripts, exact session IDs, launch-scoped MCP and hooks.
import { randomUUID } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { SessionRecord } from '../../shared/model'
import { shellJoin } from '../../shared/shell'
import { statePath } from '../state'
import { clean, foldLines, glob, isRecord, promptTitle, strings, timestamp, type Scan } from '../stores'
import {
  Harness,
  historyMessage,
  type Launch,
  type Marker,
  type NativeActivity,
  type NativeConversation,
} from './harness'

const interrupts = new Set(['[Request interrupted by user]', '[Request interrupted by user for tool use]'])
const finishedReasons = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal'])
const hookEvents = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SessionEnd',
  'StopFailure',
  'PostToolUseFailure',
  'Notification',
  'Elicitation',
  'ElicitationResult',
]

export class Claude extends Harness {
  readonly id = 'claude' as const
  readonly selectionOptions = [
    '--session-id',
    '--resume',
    '-r',
    '--continue',
    '-c',
    '--fork-session',
    '--no-session-persistence',
  ]

  async create() {
    // Claude Code accepts a new conversation's ID with --session-id.
    return randomUUID()
  }

  /** Title and working directory from a transcript's leading records; the last custom title wins. */
  private summary(path: string) {
    return foldLines(
      `claude-summary:${path}`,
      path,
      () => ({ root: '', title: '', custom: '', created: null as string | null }),
      (value, record) => {
        if (!value.root && typeof record.cwd === 'string') value.root = record.cwd
        value.created ??= timestamp(record.timestamp)
        if (record.type === 'custom-title') value.custom = clean(record.customTitle, 200)
        else if (!value.title && record.type === 'user' && isRecord(record.message))
          value.title = promptTitle([...strings(record.message.content)].join(' '))
        return value
      },
    )
  }

  private conversation(path: string, home: string): NativeConversation {
    const id = basename(path, '.jsonl')
    const summary = this.summary(path)
    let updated: string | null = null
    try {
      updated = timestamp(statSync(path).mtimeMs)
    } catch {
      /* Removed meanwhile. */
    }
    return {
      id,
      root: summary.root,
      title: summary.custom || summary.title || id,
      created: summary.created,
      updated,
      // Subagent transcripts belong to this conversation.
      history: [path, ...glob(join(dirname(path), id, 'subagents'), 'agent-*.jsonl', home)],
      storage: this.storage(home),
      format: '',
    }
  }

  *discover(environment: Record<string, string>, scan: Scan, cwd?: string) {
    const home = this.home(environment, cwd)
    if (!scan.enterStore(this.id, home)) return
    for (const path of glob(home, 'projects/*/*.jsonl')) {
      scan.check()
      scan.files++
      if (this.validId(basename(path, '.jsonl'))) yield this.conversation(path, home)
    }
  }

  *text(record: Record<string, unknown>) {
    if ((record.type === 'user' || record.type === 'assistant') && isRecord(record.message))
      yield* strings(record.message.content)
  }

  transcript(session: SessionRecord, conversation: string) {
    let newest: { path: string; mtime: number } | null = null
    for (const path of glob(this.storeOf(session), `projects/*/${conversation}.jsonl`)) {
      try {
        const mtime = statSync(path).mtimeMs
        if (!newest || mtime > newest.mtime) newest = { path, mtime }
      } catch {
        /* Removed meanwhile. */
      }
    }
    return newest?.path ?? null
  }

  title(session: SessionRecord, conversation: string) {
    const path = this.transcript(session, conversation)
    if (!path) return null
    const summary = this.summary(path)
    return summary.custom || summary.title || null
  }

  activity(record: Record<string, unknown>): NativeActivity | null {
    if (record.isSidechain) return null
    const at = record.timestamp
    if (record.isApiErrorMessage || (record.type === 'system' && record.subtype === 'api_error'))
      return { state: 'error', timestamp: at, turn: null }
    const message = record.message
    if (!isRecord(message)) return null
    if (record.type === 'user') {
      // Native interrupt records are not a new human prompt.
      const content = message.content
      const interrupted =
        Array.isArray(content) &&
        content.some(part => isRecord(part) && part.type === 'text' && interrupts.has(part.text as string))
      return { state: interrupted ? 'idle' : 'working', timestamp: at, turn: null }
    }
    if (record.type === 'assistant')
      return {
        state: finishedReasons.has(message.stop_reason as string) ? 'finished' : 'working',
        timestamp: at,
        turn: null,
      }
    return null
  }

  // Claude can flush an older prompt after its reply; within a bounded tail,
  // the newest native timestamp wins, with file order breaking ties.
  marker(records: Iterable<{ record: Record<string, unknown>; offset: number }>) {
    let selected: Marker | null = null
    let newest: number | null = null
    let first: number | null = null
    for (const { record, offset } of records) {
      first ??= offset
      if (selected && first - offset > 4 * 1024 * 1024) break
      const activity = this.activity(record)
      if (!activity) continue
      const created = timeOf(activity.timestamp)
      if (!selected) {
        selected = { activity, offset }
        newest = created
        if (created === null) return selected
      } else if (created !== null && newest !== null && created > newest) {
        selected = { activity, offset }
        newest = created
      }
    }
    return selected
  }

  update(record: Record<string, unknown>, offset: number, previous: Marker | null) {
    const activity = this.activity(record)
    if (!activity) return previous
    const before = previous && timeOf(previous.activity.timestamp)
    const after = timeOf(activity.timestamp)
    return before !== null && after !== null && after < before ? previous : { activity, offset }
  }

  *historyPaths(home: string) {
    yield* glob(home, 'projects/*/*.jsonl')
    yield* glob(home, 'projects/*/*/subagents/agent-*.jsonl')
  }

  historySession(path: string, home: string) {
    const parts = relative(home, path).split(sep)
    let main = path
    if (parts.length === 5 && parts[0] === 'projects' && this.validId(parts[2]) && parts[3] === 'subagents')
      main = join(home, parts[0], parts[1], `${parts[2]}.jsonl`)
    else if (!(parts.length === 3 && parts[0] === 'projects' && this.validId(basename(path, '.jsonl'))))
      throw new Error('Invalid Claude history path')
    return { ...this.conversation(main, home), history: [path] }
  }

  *historyMessages(record: Record<string, unknown>) {
    if ((record.type === 'user' || record.type === 'assistant') && isRecord(record.message))
      yield historyMessage(
        record.type,
        [...strings(record.message.content)].join('\n'),
        timestamp(record.timestamp),
        record.turnId,
      )
  }

  async mcp(launch: Launch) {
    const servers = Object.fromEntries(
      launch.servers.map(server => [
        server.name,
        { type: 'stdio', command: server.command, args: server.args, env: server.env },
      ]),
    )
    // The launch places resume() after these options, ending variadic --mcp-config.
    return ['--mcp-config', JSON.stringify({ mcpServers: servers })]
  }

  async hooks(launch: Launch) {
    const command = shellJoin(launch.hook)
    const hooks = Object.fromEntries(
      hookEvents.map(name => [name, [{ hooks: [{ type: 'command', command, timeout: 2 }] }]]),
    )
    return ['--settings', JSON.stringify({ hooks })]
  }

  resume(session: SessionRecord, conversation: string) {
    const path = this.transcript(session, conversation)
    return path ? ['--resume', path] : ['--session-id', conversation]
  }

  chat(executable: string) {
    // The official adapter, installed by Required Software. Its bundled CLI is
    // not used: chat runs the machine's own claude, like terminals.
    const adapter = statePath('bin', 'claude-agent-acp')
    try {
      accessSync(adapter, constants.X_OK)
    } catch {
      throw new Error('The Claude Code ACP adapter is missing. Open Required Software to install it.')
    }
    return { command: [adapter], env: { CLAUDE_CODE_EXECUTABLE: executable, CLAUDE_AGENT_ACP_PROTOCOL: 'v1' } }
  }

  chatResumable(session: SessionRecord, conversation: string) {
    // A new conversation has no transcript until its first prompt.
    return this.transcript(session, conversation) !== null
  }
}

function timeOf(value: unknown) {
  const text = timestamp(value)
  return text ? Date.parse(text) : null
}
