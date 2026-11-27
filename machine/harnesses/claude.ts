// Claude Code: project transcripts, exact session IDs, launch-scoped MCP and hooks.
import { randomUUID } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { SessionRecord } from '../../shared/model'
import { shellJoin } from '../../shared/shell'
import { statePath } from '../state'
import { glob, isRecord, lines, newest, strings, timestamp, type Scan } from '../stores'
import { Harness, historyMessage, type Launch, type NativeConversation } from './harness'

export class Claude extends Harness {
  readonly id = 'claude' as const

  async create() {
    // Claude Code accepts a new conversation's ID with --session-id.
    return randomUUID()
  }

  /** Working directory and creation timestamp from a transcript's leading records. */
  private metadata(path: string) {
    let root = ''
    let created: string | null = null
    for (const { record } of lines(path)) {
      if (!record) continue
      if (!root && typeof record.cwd === 'string') root = record.cwd
      created ??= timestamp(record.timestamp)
      if (root && created) break
    }
    return { root, created }
  }

  private conversation(path: string, home: string): NativeConversation {
    const id = basename(path, '.jsonl')
    const meta = this.metadata(path)
    let updated: string | null = null
    try {
      updated = timestamp(statSync(path).mtimeMs)
    } catch {
      /* Removed meanwhile. */
    }
    return {
      id,
      root: meta.root,
      created: meta.created,
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
    return newest(glob(this.storeOf(session), `projects/*/${conversation}.jsonl`))
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
        // After a compact boundary, Claude Code's summary stands in for what came before.
        record.isCompactSummary === true ? 'summary' : 'message',
        record.uuid,
      )
  }

  async mcp(launch: Launch) {
    const servers = Object.fromEntries(
      [launch.outpost, ...launch.servers].map(server => [
        server.name,
        'url' in server
          ? { type: 'http', url: server.url, headers: server.headers }
          : { type: 'stdio', command: server.command, args: server.args, env: server.env },
      ]),
    )
    // The launch places other options after these, ending variadic --mcp-config.
    return ['--mcp-config', JSON.stringify({ mcpServers: servers })]
  }

  settings({ session: { config } }: Launch) {
    return [
      ...(config.instructions ? ['--append-system-prompt', config.instructions] : []),
      ...(config.model ? ['--model', config.model] : []),
    ]
  }

  async hooks(launch: Launch) {
    const command = shellJoin(launch.hook)
    const hooks = { SessionStart: [{ hooks: [{ type: 'command', command, timeout: 2 }] }] }
    return ['--settings', JSON.stringify({ hooks })]
  }

  resume(session: SessionRecord, conversation: string) {
    const path = this.transcript(session, conversation)
    return path ? ['--resume', path] : ['--session-id', conversation]
  }

  chat(executable: string) {
    // The official adapter, installed from Software on the machine page. Its bundled CLI is
    // not used: chat runs the machine's own claude, like terminals.
    const adapter = statePath('bin', 'claude-agent-acp')
    try {
      accessSync(adapter, constants.X_OK)
    } catch {
      throw new Error('The Claude Code ACP adapter is missing. Open Software on the machine page to install it.')
    }
    return { command: [adapter], env: { CLAUDE_CODE_EXECUTABLE: executable, CLAUDE_AGENT_ACP_PROTOCOL: 'v1' } }
  }

  chatResumable(session: SessionRecord, conversation: string) {
    // A new conversation has no transcript until its first prompt.
    return this.transcript(session, conversation) !== null
  }
}
