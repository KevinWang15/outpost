// Codex: rollout files, its thread index, launch-scoped MCP and trusted hooks.
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  writeSync,
} from 'node:fs'
import { join, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionRecord } from '../../shared/model'
import { shellJoin } from '../../shared/shell'
import { machineExecutable } from '../state'
import { withRpc } from '../rpc'
import { clean, foldLines, glob, isRecord, lines, strings, timestamp, type Scan } from '../stores'
import { Harness, historyMessage, turnId, type Launch, type NativeActivity, type NativeConversation } from './harness'

const hookEvents = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SessionEnd',
  'Interrupt',
]
/** A new conversation must not inherit another thread's ancestry or identity. */
const inherited = [
  'git',
  'forked_from_id',
  'forked_from_ordinal_exclusive',
  'parent_thread_id',
  'history_base',
  'subagent_history_start_ordinal',
  'agent_nickname',
  'agent_role',
  'agent_path',
  'thread_source',
  'dynamic_tools',
]

/** The small JSON-shaped subset of TOML that Codex's -c overrides take. */
export function toml(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`
  if (isRecord(value))
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`)
      .join(',')}}`
  throw new Error('Unsupported Codex configuration value')
}

export class Codex extends Harness {
  readonly id = 'codex' as const
  readonly selectionOptions = ['--last']

  /** Thread names from Codex's session index; the last entry for an ID wins. */
  private titles(home: string) {
    return foldLines(
      `codex-titles:${home}`,
      join(home, 'session_index.jsonl'),
      () => new Map<string, string>(),
      (titles, record) => {
        if (typeof record.id === 'string' && typeof record.thread_name === 'string')
          titles.set(record.id, clean(record.thread_name, 200))
        return titles
      },
    )
  }

  private meta(path: string) {
    for (const { record } of lines(path)) {
      const payload = record?.type === 'session_meta' ? record.payload : null
      return isRecord(payload) && this.validId(payload.id) ? payload : null
    }
    return null
  }

  private conversation(path: string, home: string, meta: Record<string, unknown>): NativeConversation {
    const id = meta.id as string
    let updated: string | null = null
    try {
      updated = timestamp(statSync(path).mtimeMs)
    } catch {
      /* Removed meanwhile. */
    }
    return {
      id,
      root: typeof meta.cwd === 'string' ? meta.cwd : '',
      title: this.titles(home).get(id) || `Codex conversation ${id.slice(0, 8)}`,
      created: timestamp(meta.timestamp),
      updated,
      history: [path],
      storage: this.storage(home),
      format: '',
      forkedFrom: this.validId(meta.forked_from_id) ? meta.forked_from_id : null,
    }
  }

  *discover(environment: Record<string, string>, scan: Scan, cwd?: string) {
    const home = this.home(environment, cwd)
    if (!scan.enterStore(this.id, home)) return
    for (const folder of ['sessions', 'archived_sessions'])
      for (const path of glob(home, `${folder}/**/rollout-*.jsonl`)) {
        scan.check()
        scan.files++
        const meta = this.meta(path)
        if (meta) yield this.conversation(path, home, meta)
      }
  }

  *text(record: Record<string, unknown>) {
    if (record.type === 'response_item') yield* strings(record.payload)
    else if (record.type === 'event_msg' && isRecord(record.payload)) {
      const payload = record.payload
      if (payload.type === 'user_message' || payload.type === 'agent_message') yield* strings(payload.message)
    }
  }

  /** The rollout Codex's own thread index selects; reverts leave obsolete
   * segments behind, so filenames and modification times are never used. */
  transcript(session: SessionRecord, conversation: string) {
    const home = this.storeOf(session)
    const database = join(home, 'state_5.sqlite')
    if (!existsSync(database) || lstatSync(database).isSymbolicLink()) return null
    let row: { rollout_path?: unknown } | undefined
    const connection = new DatabaseSync(database, { readOnly: true, timeout: 100 })
    try {
      row = connection.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(conversation) as typeof row
    } finally {
      connection.close()
    }
    const path = row?.rollout_path
    if (typeof path !== 'string' || !path.startsWith('/')) return null
    try {
      if (lstatSync(path).isSymbolicLink() || !realpathSync(path).startsWith(realpathSync(home) + sep)) return null
    } catch {
      return null // A new thread can run before its rollout exists.
    }
    return path
  }

  title(session: SessionRecord, conversation: string) {
    return this.titles(this.storeOf(session)).get(conversation) || null
  }

  activity(record: Record<string, unknown>): NativeActivity | null {
    const payload = record.payload
    if (record.type !== 'event_msg' || !isRecord(payload)) return null
    const at = record.timestamp
    const turn = turnId(payload.turn_id)
    switch (payload.type) {
      case 'task_started':
        return { state: 'working', timestamp: at, turn }
      case 'task_complete':
        return { state: payload.error ? 'error' : 'finished', timestamp: at, turn }
      case 'turn_aborted':
        return { state: 'idle', timestamp: at, turn }
    }
    const item = payload.type === 'item_completed' && isRecord(payload.item) ? payload.item.type : null
    // /review starts delegated work without a parent task_started.
    if (payload.type === 'entered_review_mode' || item === 'EnteredReviewMode')
      return { state: 'unknown', timestamp: at, turn }
    if (payload.type === 'exited_review_mode' || item === 'ExitedReviewMode')
      return { state: 'idle', timestamp: at, turn }
    return null
  }

  *historyPaths(home: string) {
    for (const folder of ['sessions', 'archived_sessions']) yield* glob(home, `${folder}/**/rollout-*.jsonl`)
  }

  historySession(path: string, home: string) {
    const parts = relative(home, path).split(sep)
    if (parts.length < 2 || !['sessions', 'archived_sessions'].includes(parts[0]))
      throw new Error('Invalid Codex history path')
    const meta = this.meta(path)
    if (!meta) throw new Error('Invalid Codex history metadata')
    return this.conversation(path, home, meta)
  }

  *historyMessages(record: Record<string, unknown>) {
    const payload = record.payload
    const at = timestamp(record.timestamp)
    if (record.type === 'response_item' && isRecord(payload)) {
      if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant'))
        yield historyMessage(
          payload.role,
          [...strings(payload.content)].join('\n'),
          at,
          payload.turn_id,
          'message',
          payload.id,
        )
      else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')
        yield historyMessage(
          'tool',
          [...strings(payload.output)].join('\n'),
          at,
          payload.call_id,
          'tool_result',
          payload.id,
        )
    } else if (record.type === 'compacted' && isRecord(payload))
      yield historyMessage('assistant', [...strings(payload.message)].join('\n'), at, null, 'summary')
  }

  /** Codex resumes by ID but has no new-ID flag, and defers writing an empty
   * thread. A metadata-only rollout reserves the ID without a model request. */
  async create(root: string, environment: Record<string, string>, executable: string) {
    const home = this.home(environment, root)
    const started = await withRpc([executable, 'app-server'], environment, root, async rpc => {
      await rpc.call('initialize', { clientInfo: { name: 'outpost', version: '1.0.0' } })
      rpc.send({ method: 'initialized', params: {} })
      return rpc.call('thread/start', { cwd: root })
    })
    const thread = started.thread
    const provider = started.modelProvider
    if (
      !isRecord(thread) ||
      !this.validId(thread.id) ||
      typeof provider !== 'string' ||
      !provider.trim() ||
      typeof thread.cliVersion !== 'string'
    )
      throw new Error('Codex returned invalid new-thread metadata.')
    const id = thread.id
    const now = new Date()
    // Resume replays session_meta, and Codex rejects a minimal one; copy the
    // newest real conversation's metadata so the shape matches this build.
    const record = this.template(home, provider) ?? { type: 'session_meta', payload: {} }
    const meta = record.payload as Record<string, unknown>
    Object.assign(meta, { id, session_id: id, cli_version: thread.cliVersion, source: 'cli', model_provider: provider })
    for (const key of inherited) delete meta[key]
    Object.assign(meta, {
      timestamp: now.toISOString(),
      cwd: root,
      originator: 'outpost',
      base_instructions: null,
      selected_capability_roots: [],
    })
    if (Array.isArray(meta.runtime_workspace_roots)) meta.runtime_workspace_roots = [root]
    if (isRecord(meta.context_window)) meta.context_window.window_id = randomUUID()
    record.timestamp = now.toISOString()
    const pad = (value: number) => String(value).padStart(2, '0')
    const day = `${now.getUTCFullYear()}/${pad(now.getUTCMonth() + 1)}/${pad(now.getUTCDate())}`
    const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-')
    const directory = join(home, 'sessions', day)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const descriptor = openSync(join(directory, `rollout-${stamp}-${id}.jsonl`), 'wx', 0o600)
    try {
      writeSync(descriptor, `${JSON.stringify(record)}\n`)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    return id
  }

  private template(home: string, provider: string): Record<string, unknown> | null {
    const candidates: { path: string; mtime: number }[] = []
    for (const path of glob(home, 'sessions/**/rollout-*.jsonl')) {
      try {
        candidates.push({ path, mtime: statSync(path).mtimeMs })
      } catch {
        /* Removed meanwhile. */
      }
      if (candidates.length > 20_000) break
    }
    for (const { path } of candidates.sort((a, b) => b.mtime - a.mtime).slice(0, 200)) {
      for (const { record } of lines(path)) {
        const meta = record?.type === 'session_meta' ? record.payload : null
        if (
          isRecord(meta) &&
          meta.originator !== 'outpost' &&
          this.validId(meta.id) &&
          meta.source === 'cli' &&
          meta.model_provider === provider
        )
          return record
        break
      }
    }
    return null
  }

  async mcp(launch: Launch) {
    return [launch.outpost, ...launch.servers].flatMap(server => [
      '-c',
      `mcp_servers.${server.name}=${toml(
        'url' in server
          ? { url: server.url, http_headers: server.headers }
          : { command: server.command, args: server.args, env: server.env },
      )}`,
    ])
  }

  settings({ session: { config } }: Launch) {
    return [
      ...(config.instructions ? ['-c', `developer_instructions=${toml(config.instructions)}`] : []),
      // Root -c overrides reach `resume` too.
      ...(config.model ? ['-c', `model=${toml(config.model)}`] : []),
    ]
  }

  /** Hooks from the command line need Codex's trust. Ask Codex for the keys and
   * hashes of exactly these hooks, and trust only them, never user hooks. */
  async hooks(launch: Launch) {
    const command = shellJoin(launch.hook)
    const options = hookEvents.flatMap(name => [
      '-c',
      `hooks.${name}=${toml([{ hooks: [{ type: 'command', command, timeout: 2 }] }])}`,
    ])
    const listed = await withRpc(
      [launch.executable, 'app-server', ...options],
      launch.environment,
      launch.session.rootDir,
      async rpc => {
        await rpc.call('initialize', {
          clientInfo: { name: 'outpost_activity', version: '1.0.0' },
          capabilities: { experimentalApi: true },
        })
        rpc.send({ method: 'initialized', params: {} })
        return rpc.call('hooks/list', { cwds: [launch.session.rootDir] })
      },
    )
    const trusted: Record<string, { enabled: true; trusted_hash: string }> = {}
    for (const entry of Array.isArray(listed.data) ? listed.data : [])
      for (const hook of isRecord(entry) && Array.isArray(entry.hooks) ? entry.hooks : [])
        if (isRecord(hook) && hook.source === 'sessionFlags' && hook.command === command) {
          if (
            typeof hook.key !== 'string' ||
            typeof hook.currentHash !== 'string' ||
            !hook.currentHash.startsWith('sha256:')
          )
            throw new Error('Codex returned invalid hook metadata')
          trusted[hook.key] = { enabled: true, trusted_hash: hook.currentHash }
        }
    if (Object.keys(trusted).length !== hookEvents.length)
      throw new Error('This Codex version does not expose the required lifecycle hooks')
    // Dotted -c keys are not parsed as TOML keys, and hook IDs contain dots.
    return [...options, '-c', `hooks.state=${toml(trusted)}`]
  }

  resume(_session: SessionRecord, conversation: string) {
    return ['resume', conversation]
  }

  chat(executable: string) {
    // The pinned Codex ACP adapter is bundled in Outpost Terminal.
    return { command: [machineExecutable(), 'agent', 'codex'], env: { CODEX_PATH: executable, NO_BROWSER: '1' } }
  }
}
