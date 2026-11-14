// The coding harness adapter contract. Each harness (machine/harnesses/<id>.ts)
// owns its native identity, store format, launch integration and activity
// records; nothing outside an adapter branches on harness names.
import type * as acp from '@agentclientprotocol/sdk'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { ActivityState } from '../../shared/activity'
import { harnesses, type HarnessId } from '../../shared/harnesses'
import type { SessionRecord } from '../../shared/model'
import type { Scan } from '../stores'

/** A lifecycle record from the tool's own transcript; no prompt or tool content. */
export interface NativeActivity {
  state: ActivityState
  timestamp: unknown
  turn: string | null
}
export type Marker = { activity: NativeActivity; offset: number }

export interface NativeConversation {
  id: string
  /** The directory the conversation runs in, as the tool recorded it. */
  root: string
  title: string
  created: string | null
  updated: string | null
  /** Transcript files holding its messages (the main one first). */
  history: string[]
  storage: Record<string, string>
  /** Store format version, for adapters with several. */
  format: string
  /** The conversation this one was forked from, where the tool records it. */
  forkedFrom?: string | null
}

interface HistoryMessage {
  role: 'user' | 'assistant' | 'tool'
  text: string
  timestamp: string | null
  turnId: string | null
  /** A summary replaces the messages before it (a compaction). */
  kind: 'message' | 'tool_result' | 'summary'
  /** The tool's own ID for the message, which copies into forks keep. */
  identity: string | null
}

/** A neutral MCP server: a command, or a URL (streamable HTTP). */
export type McpServer =
  | { name: string; command: string; args: string[]; env: Record<string, string> }
  | { name: string; url: string; headers: Record<string, string> }
export type McpStdioServer = Extract<McpServer, { command: string }>

export interface Launch {
  session: SessionRecord
  conversation: string
  /** The coding tool on the login PATH. */
  executable: string
  /** The environment the tool runs with (session env and storage included). */
  environment: Record<string, string>
  /** Outpost's own server; its `env` is the launch's binding. */
  outpost: McpStdioServer
  /** The session's own servers. */
  servers: McpServer[]
  /** argv of the activity hook; it reads the binding from its environment. */
  hook: string[]
}

export abstract class Harness {
  abstract readonly id: HarnessId
  /** Arguments that would select another conversation; Outpost owns that choice. */
  readonly selectionOptions: readonly string[] = []
  /** Whether hooks report turn state, or only which conversation is current. */
  readonly hookStates: boolean = true

  get definition() {
    return harnesses.find(harness => harness.id === this.id)!
  }
  get command(): string {
    return this.definition.command
  }
  get terminal() {
    const definition = this.definition
    return !('terminal' in definition && definition.terminal === false)
  }
  validId(value: unknown): value is string {
    return typeof value === 'string' && new RegExp(this.definition.nativeId).test(value)
  }
  /** The native store this environment selects (its storage variable or default). */
  home(environment: Record<string, string | undefined>, cwd?: string) {
    const home = environment.HOME || homedir()
    let path = environment[this.definition.storageKey] || join(home, this.definition.storageDirectory)
    if (path.startsWith('~/')) path = join(home, path.slice(2))
    return isAbsolute(path) ? resolve(path) : resolve(cwd ?? process.cwd(), path)
  }
  storage(home: string) {
    return { [this.definition.storageKey]: home }
  }
  /** The pinned store of a session. */
  storeOf(session: Pick<SessionRecord, 'storage'>) {
    return Object.values(session.storage)[0]
  }

  selectsSession(tokens: string[]) {
    for (const token of tokens) {
      if (token === '--') break
      if (
        this.selectionOptions.some(
          option =>
            token === option || token.startsWith(`${option}=`) || (option.length === 2 && token.startsWith(option)),
        )
      )
        return true
    }
    return false
  }

  // Conversations ------------------------------------------------------------------

  /** Allocate a conversation the tool will use, without a model request. */
  abstract create(root: string, environment: Record<string, string>, executable: string): Promise<string>
  /** Native conversations in this environment's store, without writing anything. */
  abstract discover(environment: Record<string, string>, scan: Scan, cwd?: string): Iterable<NativeConversation>
  /** Conversation text in a native record, for search. */
  abstract text(record: Record<string, unknown>): Iterable<string>
  /** The newest main transcript of a conversation in the session's store. */
  abstract transcript(session: SessionRecord, conversation: string): string | null
  /** The tool's own title for a conversation, or null. */
  abstract title(session: SessionRecord, conversation: string, scan: Scan): string | null

  find(conversation: string, environment: Record<string, string>, cwd: string, scan: Scan) {
    for (const found of this.discover(environment, scan, cwd)) if (found.id === conversation) return found
    return null
  }

  // Activity -----------------------------------------------------------------------

  abstract activity(record: Record<string, unknown>): NativeActivity | null
  /** The current lifecycle marker, from records read newest first. */
  marker(records: Iterable<{ record: Record<string, unknown>; offset: number }>): Marker | null {
    for (const { record, offset } of records) {
      const activity = this.activity(record)
      if (activity) return { activity, offset }
    }
    return null
  }
  /** Fold an appended record; `history` rereads newest first from its end. */
  update(
    record: Record<string, unknown>,
    offset: number,
    previous: Marker | null,
    _history: () => Iterable<{ record: Record<string, unknown>; offset: number }>,
  ): Marker | null {
    const activity = this.activity(record)
    return activity ? { activity, offset } : previous
  }

  // History ------------------------------------------------------------------------

  abstract historyPaths(home: string): Iterable<string>
  abstract historySession(path: string, home: string, scan: Scan, cache: Map<string, unknown>): NativeConversation
  abstract historyMessages(record: Record<string, unknown>, format: string): Iterable<HistoryMessage>
  /** The transcript's logical bytes (adapters with compressed stores decode). */
  historyBytes?(path: string): { data: Buffer; incomplete: boolean; sourceSize: number; modified: string }

  // Launch -------------------------------------------------------------------------

  /** Options that configure the launch's MCP servers natively (required);
   * the session's own servers where the registry says terminals apply them. */
  abstract mcp(launch: Launch): Promise<string[]>
  /** Options that add the session's instructions (where the registry says
   * terminals apply them) and select its model. */
  abstract settings(launch: Launch): string[]
  /** Options that install activity hooks. A failure is reported, never fatal. */
  abstract hooks(launch: Launch): Promise<string[]>
  /** Arguments that open exactly this conversation. */
  abstract resume(session: SessionRecord, conversation: string): string[]
  /** The tool's Agent Client Protocol server for chat mode. */
  abstract chat(executable: string): { command: string[]; env: Record<string, string> }
  /** Whether `session/load` can open it; otherwise chat starts it with `session/new`. */
  chatResumable(_session: SessionRecord, _conversation: string) {
    return true
  }
  /** ACP `mcpServers` for chat: Outpost's and the session's. */
  async chatServers(launch: Launch): Promise<acp.McpServer[]> {
    return [launch.outpost, ...launch.servers].map(acpServer)
  }
}

const pairs = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => ({ name, value }))
export const acpServer = (server: McpServer): acp.McpServer =>
  'url' in server
    ? { type: 'http', name: server.name, url: server.url, headers: pairs(server.headers) }
    : { name: server.name, command: server.command, args: server.args, env: pairs(server.env) }

/** A native record message with its text extracted. */
export function historyMessage(
  role: HistoryMessage['role'],
  text: string,
  timestamp: string | null,
  turnId: unknown,
  kind: HistoryMessage['kind'] = 'message',
  identity: unknown = null,
): HistoryMessage {
  return {
    role,
    text,
    timestamp,
    turnId: typeof turnId === 'string' ? turnId : null,
    kind,
    identity: typeof identity === 'string' && identity && identity.length <= 200 ? identity : null,
  }
}

/** A hook or record's turn identity, bounded. */
export function turnId(value: unknown) {
  if ((typeof value === 'string' || typeof value === 'number') && String(value)) return String(value).slice(0, 160)
  return null
}
