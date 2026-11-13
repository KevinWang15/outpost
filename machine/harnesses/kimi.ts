// Kimi Code: wire transcripts, ACP allocation, and one installed Outpost plugin
// for hooks and MCP (Kimi has no invocation-only configuration).
import { createHash } from 'node:crypto'
import { dirname, join, relative, sep } from 'node:path'
import type { SessionRecord } from '../../shared/model'
import { shellJoin } from '../../shared/shell'
import { withRpc } from '../rpc'
import { locked, readJson, statePath, writeJson } from '../state'
import { clean, foldLines, glob, isRecord, lines, newest, promptTitle, strings, timestamp, type Scan } from '../stores'
import {
  Harness,
  historyMessage,
  turnId,
  type Launch,
  type Marker,
  type NativeActivity,
  type NativeConversation,
} from './harness'

const pluginId = 'outpost'
const ended: Record<string, NativeActivity['state']> = {
  completed: 'finished',
  blocked: 'waiting',
  failed: 'error',
  cancelled: 'idle',
}

export class Kimi extends Harness {
  readonly id = 'kimi' as const
  readonly selectionOptions = ['--session', '-S', '--continue', '-c']
  // Its plugin hooks report which conversation is current, not turn state.
  readonly hookStates = false

  private index(home: string) {
    return foldLines(
      `kimi-index:${home}`,
      join(home, 'session_index.jsonl'),
      () => new Map<string, string>(),
      (index, record) => {
        if (typeof record.sessionId === 'string' && typeof record.workDir === 'string')
          index.set(record.sessionId, record.workDir)
        return index
      },
    )
  }

  private conversation(
    directory: string,
    home: string,
    scan: Scan,
    history: string[],
    format = '',
  ): NativeConversation {
    const id = directory.split(sep).at(-1)!
    const state = scan.document(join(directory, 'state.json'))
    return {
      id,
      root: this.index(home).get(id) ?? '',
      title: clean(state.title) || promptTitle(state.lastPrompt, 280) || id,
      created: timestamp(state.createdAt),
      updated: timestamp(state.updatedAt),
      history,
      storage: this.storage(home),
      format,
    }
  }

  *discover(environment: Record<string, string>, scan: Scan, cwd?: string) {
    const home = this.home(environment, cwd)
    if (!scan.enterStore(this.id, home)) return
    for (const directory of glob(home, 'sessions/*/session_*')) {
      scan.check()
      scan.files++
      const id = directory.split(sep).at(-1)!
      if (!this.validId(id)) continue
      yield this.conversation(directory, home, scan, [...glob(join(directory, 'agents'), '*/wire.jsonl', home)])
    }
  }

  *text(record: Record<string, unknown>) {
    if (
      ['context.append_message', 'turn.prompt', 'turn.steer', 'context.append_loop_event'].includes(
        record.type as string,
      )
    )
      yield* strings(record)
  }

  transcript(session: SessionRecord, conversation: string) {
    return newest(glob(this.storeOf(session), `sessions/*/${conversation}/agents/main/wire.jsonl`))
  }

  title(session: SessionRecord, conversation: string, scan: Scan) {
    const transcript = this.transcript(session, conversation)
    if (!transcript) return null
    const state = scan.document(join(dirname(dirname(dirname(transcript))), 'state.json'))
    return clean(state.title, 200) || promptTitle(state.lastPrompt) || null
  }

  activity(record: Record<string, unknown>): NativeActivity | null {
    if (record.agentId !== 'main') return null
    const at = record.time
    const turn = turnId(record.turnId)
    switch (record.type) {
      case 'turn.prompt':
      case 'turn.steer':
        return { state: 'working', timestamp: at, turn }
      case 'turn.ended':
        return { state: ended[record.reason as string] ?? 'unknown', timestamp: at, turn }
      case 'interaction.request':
        return { state: 'waiting', timestamp: at, turn }
      case 'interaction.resolved':
        return { state: 'working', timestamp: at, turn }
      case 'turn.cancel':
        return record.target === 'queued' ? null : { state: 'idle', timestamp: at, turn }
    }
    return null
  }

  // Resolving one approval must not hide another one still open.
  marker(records: Iterable<{ record: Record<string, unknown>; offset: number }>) {
    const resolved = new Set<unknown>()
    for (const { record, offset } of records) {
      if (record.agentId !== 'main') continue
      if (record.type === 'interaction.resolved') {
        resolved.add(record.id)
        continue
      }
      if (record.type === 'interaction.request' && resolved.has(record.id)) continue
      const activity = this.activity(record)
      if (activity) return { activity, offset }
    }
    return null
  }

  update(
    record: Record<string, unknown>,
    offset: number,
    previous: Marker | null,
    history: () => Iterable<{ record: Record<string, unknown>; offset: number }>,
  ) {
    if (record.agentId === 'main' && record.type === 'interaction.resolved') return this.marker(history())
    return super.update(record, offset, previous, history)
  }

  *historyPaths(home: string) {
    yield* glob(home, 'sessions/*/session_*/agents/*/wire.jsonl')
  }

  historySession(path: string, home: string, scan: Scan) {
    const parts = relative(home, path).split(sep)
    if (parts.length !== 6 || parts[0] !== 'sessions' || !this.validId(parts[2]) || parts[3] !== 'agents')
      throw new Error('Invalid Kimi history path')
    let format = 'context-messages'
    for (const { record } of lines(path)) {
      if (record?.type === 'metadata' && String(record.protocol_version) === '1.5') format = 'agent-messages'
      break
    }
    return this.conversation(join(home, parts[0], parts[1], parts[2]), home, scan, [path], format)
  }

  *historyMessages(record: Record<string, unknown>, format: string) {
    const roles = new Set(['user', 'assistant', 'tool'])
    if (format === 'agent-messages') {
      const outer = record.message
      if (record.type !== 'agent.message.appended' || !isRecord(outer) || !isRecord(outer.message)) return
      const entry = outer.message
      const meta = isRecord(outer.meta) ? outer.meta : {}
      if (roles.has(entry.role as string))
        yield historyMessage(
          entry.role as 'user',
          [...strings(entry.content)].join('\n'),
          timestamp(record.time ?? meta.createdAt),
          meta.turnId,
        )
      return
    }
    if (record.type === 'context.append_message' && isRecord(record.message)) {
      const entry = record.message
      if (roles.has(entry.role as string))
        yield historyMessage(
          entry.role as 'user',
          [...strings(entry.content)].join('\n'),
          timestamp(record.time),
          record.turnId,
        )
    } else if (
      record.type === 'context.append_loop_event' &&
      isRecord(record.event) &&
      record.event.type === 'tool.result'
    )
      yield historyMessage(
        'tool',
        [...strings(record.event.result ?? record.event.content)].join('\n'),
        timestamp(record.time),
        record.turnId,
        'tool_result',
      )
  }

  async create(root: string, environment: Record<string, string>, executable: string) {
    const result = await withRpc([executable, 'acp'], environment, root, async rpc => {
      await rpc.call('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'outpost', version: '1.0.0' },
      })
      return rpc.call('session/new', { cwd: root, mcpServers: [] })
    })
    if (!this.validId(result.sessionId)) throw new Error('Kimi returned an invalid session ID')
    return result.sessionId
  }

  /** One plugin carries the hooks and the MCP servers. It holds no session
   * identity: each server inherits its Kimi process's binding, and an
   * ordinary Kimi launch, with no binding, sees no Outpost tools. */
  private async plugin(launch: Launch) {
    const home = this.storeOf(launch.session)
    const root = statePath('integrations', 'kimi')
    const command = shellJoin(launch.hook)
    const manifest = {
      name: pluginId,
      version: '2.0.0',
      description: 'Session activity and Outpost tools for Outpost sessions.',
      interface: { displayName: 'Outpost' },
      hooks: ['SessionStart', 'UserPromptSubmit'].map(event => ({ event, command, timeout: 2 })),
      // Plugin commands must be PATH names; env runs the exact executable.
      mcpServers: Object.fromEntries(
        launch.servers.map(server => [server.name, { command: 'env', args: [server.command, ...server.args] }]),
      ),
    }
    const registry = join(home, 'plugins', 'installed.json')
    const key = createHash('sha256').update(home).digest('hex').slice(0, 16)
    await locked(`kimi-plugins-${key}`, () => {
      const data = readJson<unknown>(registry, null)
      const current = data ?? { version: 1, plugins: [] }
      if (
        !isRecord(current) ||
        current.version !== 1 ||
        !Array.isArray(current.plugins) ||
        current.plugins.some(entry => !isRecord(entry))
      )
        throw new Error('Invalid Kimi plugin registry')
      const plugins = current.plugins as Record<string, unknown>[]
      const index = plugins.findIndex(entry => entry.id === pluginId)
      const existing = index >= 0 ? plugins[index] : {}
      const entry = {
        ...existing,
        id: pluginId,
        root,
        source: 'local-path',
        enabled: true,
        installedAt: existing.installedAt ?? new Date().toISOString(),
      }
      // Keep plugin order and preferences, and avoid needless native reloads.
      if (JSON.stringify(readJson(join(root, 'kimi.plugin.json'), null)) !== JSON.stringify(manifest))
        writeJson(join(root, 'kimi.plugin.json'), manifest)
      const next = {
        ...current,
        plugins: index >= 0 ? plugins.map((item, i) => (i === index ? entry : item)) : [...plugins, entry],
      }
      if (JSON.stringify(next) !== JSON.stringify(current)) writeJson(registry, next)
    })
  }

  async mcp(launch: Launch) {
    await this.plugin(launch)
    return []
  }

  async hooks() {
    return [] // The plugin installed by mcp() carries them.
  }

  resume(_session: SessionRecord, conversation: string) {
    return ['--session', conversation]
  }

  chat(executable: string) {
    return { command: [executable, 'acp'], env: {} }
  }

  async chatServers(launch: Launch) {
    // The plugin supplies MCP; ACP must not add a second server.
    await this.plugin(launch)
    return []
  }
}
