// Kimi Code: wire transcripts, ACP allocation, and one installed Outpost plugin
// for hooks and MCP (Kimi has no invocation-only configuration).
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import type { SessionRecord } from '../../shared/model'
import { shellJoin } from '../../shared/shell'
import { terminalService } from '../../shared/terminalService'
import { withRpc } from '../rpc'
import { locked, readJson, statePath, writeJson } from '../state'
import { foldLines, glob, isRecord, newest, strings, timestamp, type Scan } from '../stores'
import { acpServer, Harness, historyMessage, type Launch, type NativeConversation } from './harness'

const pluginId = 'outpost'

export class Kimi extends Harness {
  readonly id = 'kimi' as const

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

  private conversation(directory: string, home: string, scan: Scan, history: string[]): NativeConversation {
    const id = directory.split(sep).at(-1)!
    const state = scan.document(join(directory, 'state.json'))
    return {
      id,
      root: this.index(home).get(id) ?? '',
      created: timestamp(state.createdAt),
      updated: timestamp(state.updatedAt),
      history,
      storage: this.storage(home),
      format: '',
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

  *historyPaths(home: string) {
    yield* glob(home, 'sessions/*/session_*/agents/*/wire.jsonl')
  }

  historySession(path: string, home: string, scan: Scan) {
    const parts = relative(home, path).split(sep)
    if (parts.length !== 6 || parts[0] !== 'sessions' || !this.validId(parts[2]) || parts[3] !== 'agents')
      throw new Error('Invalid Kimi history path')
    return this.conversation(join(home, parts[0], parts[1], parts[2]), home, scan, [path])
  }

  *historyMessages(record: Record<string, unknown>) {
    const roles = new Set(['user', 'assistant', 'tool'])
    if (record.type === 'context.append_message' && isRecord(record.message)) {
      const entry = record.message
      if (isRecord(entry.origin) && entry.origin.kind === 'injection') return
      if (roles.has(entry.role as string))
        yield historyMessage(
          entry.role as 'user',
          [...strings(entry.content)].join('\n'),
          timestamp(record.time),
          record.turnId,
          'message',
          entry.id,
        )
    } else if (record.type === 'context.append_loop_event' && isRecord(record.event)) {
      const event = record.event
      if (event.type === 'content.part' && isRecord(event.part) && event.part.type === 'text')
        yield historyMessage(
          'assistant',
          [...strings(event.part.text)].join('\n'),
          timestamp(record.time ?? event.startedAt),
          event.turnId ?? record.turnId,
          'message',
          event.uuid,
        )
      else if (event.type === 'tool.result')
        yield historyMessage(
          'tool',
          [...strings(event.result ?? event.content)].join('\n'),
          timestamp(record.time),
          event.turnId ?? record.turnId,
          'tool_result',
          event.uuid ?? event.toolCallId,
        )
    }
  }

  async create(root: string, environment: Record<string, string>, executable: string) {
    const result = await withRpc([executable, 'acp'], environment, root, async rpc => {
      await rpc.call('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'outpost', version: terminalService.version },
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
      description: 'Conversation tracking and Outpost tools for Outpost sessions.',
      interface: { displayName: 'Outpost' },
      hooks: ['SessionStart', 'UserPromptSubmit'].map(event => ({ event, command, timeout: 2 })),
      // Plugin commands must be PATH names; env runs the exact executable.
      mcpServers: {
        [launch.outpost.name]: { command: 'env', args: [launch.outpost.command, ...launch.outpost.args] },
      },
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

  settings({ session: { config } }: Launch) {
    return config.model ? ['--model', config.model] : []
  }

  resume(_session: SessionRecord, conversation: string) {
    return ['--session', conversation]
  }

  chat(executable: string) {
    return { command: [executable, 'acp'], env: {} }
  }

  async chatServers(launch: Launch) {
    // The plugin supplies Outpost's server; ACP must not add a second one.
    await this.plugin(launch)
    return launch.servers.map(acpServer)
  }
}
