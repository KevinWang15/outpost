// Chat host contract: `outpost-terminal chat-serve` owns one managed session's
// ACP agent on its target, as the terminal service owns a PTY. Payloads are ACP
// v1 types. The envelope adds what a single ACP client connection lacks:
// ordered sequence numbers, many viewers, a prompt queue and turn attribution.
// See docs/CHAT.md.
import type * as acp from '@agentclientprotocol/sdk'
import type { SessionActivity } from './activity'

export const chatHost = {
  protocol: 1,
  /** Journal bounds; older entries are dropped like terminal scrollback. */
  maxEntries: 20_000,
  maxBytes: 16 * 1024 * 1024,
  /** A merged text chunk grows to this size before the next one starts. */
  maxText: 64 * 1024,
  /** Tool inputs, outputs and other strings the agent reports. */
  maxField: 64 * 1024,
  /** Retained tail of a command's streamed output. */
  maxOutput: 256 * 1024,
  maxQueue: 32,
  maxImages: 8,
  maxImageBytes: 5 * 1024 * 1024,
  maxOrigin: 4096,
  /** A bridge (MCP) call waits this long for Outpost to answer. */
  callMs: 30_000,
} as const

/** Display attribution for a prompt the user did not type in this session. */
export type ChatOrigin =
  | { kind: 'user' }
  | { kind: 'channel'; channelId: string; channel: string; messageId: string; summary: string }
  | { kind: 'session'; from: ChatPeer; threadId: string; summary: string }
  | { kind: 'reply'; from: ChatPeer; threadId: string; summary: string }
  | { kind: 'schedule'; scheduleId: string; name: string }
export interface ChatPeer {
  targetId: string
  sessionId: string
  name: string
}

interface EntryBase {
  seq: number
  at: string
}
export type ChatEntry = EntryBase &
  (
    | { kind: 'queued'; turn: string; key: string | null; origin: ChatOrigin; prompt: acp.ContentBlock[] }
    | { kind: 'unqueued'; turn: string }
    | { kind: 'started'; turn: string }
    | { kind: 'ended'; turn: string; stopReason: acp.StopReason | 'error'; error: string | null }
    | { kind: 'update'; turn: string | null; update: acp.SessionUpdate }
    | { kind: 'permission'; turn: string; id: string; toolCall: acp.ToolCallUpdate; options: acp.PermissionOption[] }
    | { kind: 'resolved'; turn: string; id: string; optionId: string | null }
    | { kind: 'history'; phase: 'begin' | 'end' }
    | { kind: 'notice'; level: 'info' | 'warning' | 'error'; text: string; turn: string | null }
  )
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type ChatEntryInput = DistributiveOmit<ChatEntry, 'seq' | 'at'>

/** Latest-value session state. It is replaced, not journaled. */
export interface ChatInfo {
  state: 'starting' | 'identity' | 'ready' | 'failed' | 'exited'
  error: string | null
  agent: { name: string; title: string | null; version: string | null } | null
  nativeId: string | null
  title: string | null
  modes: acp.SessionModeState | null
  config: acp.SessionConfigOption[]
  commands: acp.AvailableCommand[]
  usage: { used: number; size: number; cost: acp.Cost | null } | null
  images: boolean
  instructions: 'applied' | 'unsupported' | 'none'
  /** The same turn state as terminal sessions, for lists and badges. */
  activity: SessionActivity
}

export interface ChatJournalSnapshot {
  lastSeq: number
  truncated: boolean
  entries: ChatEntry[]
}

/** The `status` reply, also read by the target runtime's session list. */
export interface ChatHostStatus {
  type: 'status'
  version: string
  protocol: number
  pid: number
  clients: number
  state: ChatInfo['state']
  nativeId: string | null
  activity: SessionActivity
}

// Host → client frames (JSON in relay `C` frames).
export type ChatHostMessage =
  | { type: 'welcome'; protocol: number; info: ChatInfo; journal: ChatJournalSnapshot }
  | { type: 'entry'; entry: ChatEntry }
  | { type: 'info'; info: ChatInfo }
  | { type: 'identity'; nativeId: string }
  | { type: 'call'; id: string; tool: string; arguments: unknown; turn: string | null; origin: ChatOrigin | null }
  | { type: 'result'; id: string; ok: boolean; message?: string; data?: unknown }
  | { type: 'error'; message: string }
  | ChatHostStatus

// Client → host frames.
export type ChatHostRequest =
  | { type: 'hello'; protocol: number; role: 'viewer' | 'hub' }
  | { type: 'status' }
  | { type: 'prompt'; id: string; key: string | null; origin: ChatOrigin; prompt: acp.ContentBlock[] }
  | { type: 'cancel'; id: string }
  | { type: 'unqueue'; id: string; turn: string }
  | { type: 'permission'; id: string; request: string; optionId: string | null }
  | { type: 'config'; id: string; configId: string; value: string | boolean }
  | { type: 'mode'; id: string; modeId: string }
  /** Also a one-shot request without hello; it then replies with `status`. */
  | { type: 'seen'; id?: string; completionId: string }
  | { type: 'note'; id: string; level: 'info' | 'warning' | 'error'; text: string }
  | { type: 'identity-saved'; nativeId: string }
  | { type: 'answer'; id: string; ok: boolean; message?: string; data?: unknown }
  | { type: 'ping'; id: string }
  | { type: 'call'; id: string; tool: string; arguments: unknown }

/** Launch configuration, written to `chat-serve` on stdin by the target runtime. */
export interface ChatLaunch {
  socket: string
  session: string
  command: string[]
  cwd: string
  env: Record<string, string>
  /** Load this native conversation; otherwise start one and confirm its identity. */
  resume: string | null
  mcpServers: acp.McpServerStdio[]
  instructions: string | null
}

// Bounds -------------------------------------------------------------------------

/** Truncate long strings and lists in agent-reported data before keeping it. */
export function bounded(value: unknown, depth = 0): unknown {
  if (typeof value === 'string')
    return value.length > chatHost.maxField
      ? `${value.slice(0, chatHost.maxField)}… [${value.length - chatHost.maxField} more characters]`
      : value
  if (value === null || typeof value !== 'object') return value
  if (depth >= 12) return '[…]'
  if (Array.isArray(value)) return value.slice(0, 500).map(item => bounded(item, depth + 1))
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, 200)) result[key] = bounded(item, depth + 1)
  return result
}

/** Keep a prompt's text and image metadata; image bytes are not journaled. */
export function journalBlock(block: acp.ContentBlock): acp.ContentBlock {
  if (block.type === 'image' || block.type === 'audio')
    return { ...block, data: '', _meta: { ...block._meta, outpost: { omittedBytes: block.data.length } } }
  if (block.type === 'resource' && 'blob' in block.resource)
    return { ...block, resource: { ...block.resource, blob: '' } }
  return bounded(block) as acp.ContentBlock
}

// Journal ------------------------------------------------------------------------

const chunkKinds = new Set(['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'])
const toolKinds = new Set(['tool_call', 'tool_call_update'])
const toolMergeWindow = 2000
const maxToolEstimate = 6 * chatHost.maxField + chatHost.maxOutput

type UpdateEntry = Extract<ChatEntry, { kind: 'update' }>
type Meta = Record<string, unknown>
const record = (value: unknown): value is Meta => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Streamed command output is an ACP extension (`_meta.terminal_output_delta`);
 * it is kept as one bounded `_meta.outpost.output` tail per tool call. */
function normalize(update: acp.SessionUpdate): acp.SessionUpdate {
  if (!toolKinds.has(update.sessionUpdate) || !record(update._meta)) return update
  const { terminal_output_delta: delta, terminal_output: output, ...rest } = update._meta
  const chunk = [delta, output].find(item => record(item) && typeof item.data === 'string') as Meta | undefined
  if (!chunk) return update
  const outpost = record(rest.outpost) ? rest.outpost : {}
  return {
    ...update,
    _meta: { ...rest, outpost: { ...outpost, output: (chunk.data as string).slice(-chatHost.maxOutput) } },
  }
}

function mergeTool(base: acp.SessionUpdate, next: acp.SessionUpdate): acp.SessionUpdate {
  const merged: Meta = { ...base }
  for (const [key, value] of Object.entries(next)) {
    if (key === 'sessionUpdate' || key === '_meta' || value === undefined) continue
    merged[key] = value
  }
  if (record(next._meta)) {
    const before = record(base._meta) ? base._meta : {}
    const meta: Meta = { ...before, ...next._meta }
    const previous = record(before.outpost) && typeof before.outpost.output === 'string' ? before.outpost.output : ''
    const added = record(next._meta.outpost) ? next._meta.outpost.output : undefined
    if (typeof added === 'string')
      meta.outpost = {
        ...(record(before.outpost) ? before.outpost : {}),
        output: (previous + added).slice(-chatHost.maxOutput),
      }
    merged._meta = meta
  }
  return merged as acp.SessionUpdate
}

const textOf = (update: acp.SessionUpdate) =>
  chunkKinds.has(update.sessionUpdate) &&
  'content' in update &&
  record(update.content) &&
  update.content.type === 'text' &&
  typeof update.content.text === 'string'
    ? update.content.text
    : null

/** One ordered log per session. The host records entries; viewers apply the
 * same entries in sequence and therefore hold the same compacted state. */
export class ChatJournal {
  entries: ChatEntry[] = []
  lastSeq = 0
  truncated = false
  /** Increments on every change, for renderers. */
  version = 0
  private sizes: number[] = []
  private bytes = 0

  constructor(
    private limits: { entries: number; bytes: number } = { entries: chatHost.maxEntries, bytes: chatHost.maxBytes },
  ) {}

  /** Host side: assign the next sequence number. */
  record(input: ChatEntryInput, at = new Date().toISOString()): ChatEntry {
    const entry = { ...input, seq: this.lastSeq + 1, at } as ChatEntry
    this.apply(entry)
    return entry
  }

  /** Viewer side: false means a gap, and the viewer must resubscribe. */
  accept(entry: ChatEntry) {
    if (entry.seq !== this.lastSeq + 1) return false
    this.apply(entry)
    return true
  }

  load(snapshot: ChatJournalSnapshot) {
    this.entries = []
    this.sizes = []
    this.bytes = 0
    this.lastSeq = snapshot.lastSeq
    this.truncated = snapshot.truncated
    for (const entry of snapshot.entries) this.keep(entry)
    this.version++
  }

  snapshot(): ChatJournalSnapshot {
    return { lastSeq: this.lastSeq, truncated: this.truncated, entries: this.entries }
  }

  private keep(entry: ChatEntry, size = JSON.stringify(entry).length) {
    this.entries.push(entry)
    this.sizes.push(size)
    this.bytes += size
  }

  private replace(index: number, entry: ChatEntry, size: number) {
    this.bytes += size - this.sizes[index]
    this.entries[index] = entry
    this.sizes[index] = size
  }

  private apply(entry: ChatEntry) {
    this.lastSeq = entry.seq
    this.version++
    if (entry.kind === 'update') {
      const update = normalize(entry.update)
      const normalized: UpdateEntry = update === entry.update ? entry : { ...entry, update }
      if (!this.merge(normalized)) this.keep(normalized)
    } else this.keep(entry)
    while ((this.entries.length > this.limits.entries || this.bytes > this.limits.bytes) && this.entries.length > 1) {
      this.entries.shift()
      this.bytes -= this.sizes.shift()!
      this.truncated = true
    }
  }

  /** Coalesce streamed chunks and tool reports into the entry they extend. */
  private merge(entry: UpdateEntry) {
    const { update } = entry
    const added = textOf(update)
    if (added !== null) {
      const index = this.entries.length - 1
      const last = this.entries[index]
      if (last?.kind !== 'update' || last.turn !== entry.turn || last.update.sessionUpdate !== update.sessionUpdate)
        return false
      const previous = textOf(last.update)
      const lastId = 'messageId' in last.update ? (last.update.messageId ?? null) : null
      const nextId = 'messageId' in update ? (update.messageId ?? null) : null
      if (previous === null || lastId !== nextId || previous.length + added.length > chatHost.maxText) return false
      const content = { ...(last.update as acp.ContentChunk).content, text: previous + added } as acp.ContentBlock
      this.replace(
        index,
        { ...last, update: { ...last.update, content } as acp.SessionUpdate },
        this.sizes[index] + added.length,
      )
      return true
    }
    const kind = update.sessionUpdate
    if (kind === 'tool_call_update' || kind === 'tool_call') {
      const id = update.toolCallId
      for (let index = this.entries.length - 1; index >= Math.max(0, this.entries.length - toolMergeWindow); index--) {
        const candidate = this.entries[index]
        if (
          candidate.kind === 'update' &&
          candidate.turn === entry.turn &&
          toolKinds.has(candidate.update.sessionUpdate) &&
          (candidate.update as acp.ToolCall).toolCallId === id
        ) {
          const size = Math.min(this.sizes[index] + JSON.stringify(update).length, maxToolEstimate)
          this.replace(index, { ...candidate, update: mergeTool(candidate.update, update) }, size)
          return true
        }
      }
      return false
    }
    if (kind === 'plan' || kind === 'compaction_update') {
      for (let index = this.entries.length - 1; index >= Math.max(0, this.entries.length - toolMergeWindow); index--) {
        const candidate = this.entries[index]
        if (candidate.kind === 'started' && candidate.turn === entry.turn) break
        if (candidate.kind !== 'update' || candidate.turn !== entry.turn) continue
        const same =
          kind === 'plan'
            ? candidate.update.sessionUpdate === 'plan'
            : candidate.update.sessionUpdate === 'compaction_update' &&
              candidate.update.compactionId === (update as acp.CompactionUpdate).compactionId
        if (same) {
          this.replace(index, { ...candidate, update }, JSON.stringify(update).length + 64)
          return true
        }
      }
    }
    return false
  }
}
