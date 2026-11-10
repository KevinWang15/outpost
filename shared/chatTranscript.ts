// Display model of one session's chat journal. Live turns and history replayed
// by `session/load` share the same items; history turns are split where the
// agent replays a user message, and attributed from Outpost's prompt header.
import type * as acp from '@agentclientprotocol/sdk'
import type { ChatEntry, ChatOrigin } from './chatHost'

/** Prompts Outpost composes start with this line so a replay can attribute them. */
export const promptHeaderPattern = /^\[Outpost: ([^\]\n]{1,200})\]\n/
export const promptHeader = (label: string) => `[Outpost: ${label.replace(/[\]\n]/g, ' ').slice(0, 200)}]\n`

export interface ToolView {
  type: 'tool'
  key: string
  id: string
  title: string
  kind: acp.ToolKind | null
  status: acp.ToolCallStatus
  input: unknown
  output: unknown
  content: acp.ToolCallContent[]
  locations: acp.ToolCallLocation[]
  /** Streamed command output (`_meta.outpost.output`). */
  terminal: string | null
}
export type TurnItem =
  | { type: 'text'; key: string; text: string }
  | { type: 'thought'; key: string; text: string }
  | { type: 'image'; key: string; mimeType: string; data: string; uri: string | null }
  | { type: 'link'; key: string; name: string; uri: string }
  | ToolView
  | { type: 'plan'; key: string; entries: acp.PlanEntry[] }
  | {
      type: 'permission'
      key: string
      id: string
      toolCall: acp.ToolCallUpdate
      options: acp.PermissionOption[]
      resolved: boolean
      optionId: string | null
    }
  | { type: 'notice'; key: string; level: string; text: string }
  | { type: 'compaction'; key: string; status: string; error: string | null }

export type TurnStatus = 'queued' | 'running' | 'done' | 'cancelled' | 'error' | 'removed' | 'history'
export interface TurnView {
  id: string
  /** null for history replayed from the agent's own store. */
  origin: ChatOrigin | null
  /** Display label for an Outpost-composed prompt, live or replayed. */
  label: string | null
  prompt: acp.ContentBlock[]
  status: TurnStatus
  stopReason: string | null
  error: string | null
  items: TurnItem[]
  queuedAt: string | null
  startedAt: string | null
  endedAt: string | null
}
export interface Transcript {
  truncated: boolean
  turns: TurnView[]
  queue: TurnView[]
  pending: Extract<TurnItem, { type: 'permission' }>[]
  running: TurnView | null
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function labelOf(origin: ChatOrigin | null, prompt: acp.ContentBlock[]) {
  if (origin && origin.kind !== 'user') {
    if (origin.kind === 'channel') return `#${origin.channel}`
    if (origin.kind === 'schedule') return `Scheduled · ${origin.name}`
    return `${origin.kind === 'reply' ? 'Reply from' : 'From'} ${origin.from.name}`
  }
  const first = prompt[0]
  const match = first?.type === 'text' ? first.text.match(promptHeaderPattern) : null
  return match ? match[1] : null
}

function toolView(update: acp.ToolCall | acp.ToolCallUpdate): ToolView {
  const meta = record(update._meta) && record(update._meta.outpost) ? update._meta.outpost : null
  return {
    type: 'tool',
    key: `tool:${update.toolCallId}`,
    id: update.toolCallId,
    title: update.title || update.name || 'Tool call',
    kind: update.kind ?? null,
    status: update.status ?? 'pending',
    input: update.rawInput,
    output: update.rawOutput,
    content: update.content ?? [],
    locations: update.locations ?? [],
    terminal: typeof meta?.output === 'string' ? meta.output : null,
  }
}

function mergeToolView(view: ToolView, update: acp.ToolCallUpdate): ToolView {
  const next = toolView({ ...update, title: update.title ?? view.title })
  return {
    ...view,
    title: update.title || update.name || view.title,
    kind: update.kind ?? view.kind,
    status: update.status ?? view.status,
    input: update.rawInput !== undefined ? update.rawInput : view.input,
    output: update.rawOutput !== undefined ? update.rawOutput : view.output,
    content: update.content ?? view.content,
    locations: update.locations ?? view.locations,
    terminal: next.terminal ?? view.terminal,
  }
}

function addBlock(turn: TurnView, kind: 'text' | 'thought', messageId: string | null, block: acp.ContentBlock) {
  const last = turn.items.at(-1)
  if (block.type === 'text') {
    const key = `${kind}:${messageId ?? ''}`
    if (last && last.type === kind && last.key.startsWith(key)) {
      turn.items[turn.items.length - 1] = { ...last, text: last.text + block.text }
      return
    }
    turn.items.push({ type: kind, key: `${key}:${turn.items.length}`, text: block.text })
  } else if (block.type === 'image' && kind === 'text') {
    turn.items.push({
      type: 'image',
      key: `image:${turn.items.length}`,
      mimeType: block.mimeType,
      data: block.data,
      uri: block.uri ?? null,
    })
  } else if (block.type === 'resource_link' && kind === 'text') {
    turn.items.push({ type: 'link', key: `link:${turn.items.length}`, name: block.title || block.name, uri: block.uri })
  }
}

function applyUpdate(turn: TurnView, update: acp.SessionUpdate, live: boolean) {
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      // Live turns already hold their prompt; replay rebuilds it from chunks.
      if (!live) {
        turn.prompt = [...turn.prompt, update.content]
        turn.label = labelOf(turn.origin, turn.prompt)
      }
      return
    case 'agent_message_chunk':
      return addBlock(turn, 'text', update.messageId ?? null, update.content)
    case 'agent_thought_chunk':
      return addBlock(turn, 'thought', update.messageId ?? null, update.content)
    case 'tool_call':
    case 'tool_call_update': {
      const index = turn.items.findIndex(item => item.type === 'tool' && item.id === update.toolCallId)
      if (index >= 0) turn.items[index] = mergeToolView(turn.items[index] as ToolView, update)
      else turn.items.push(toolView(update))
      return
    }
    case 'plan': {
      const index = turn.items.findIndex(item => item.type === 'plan')
      const item = { type: 'plan' as const, key: 'plan', entries: update.entries }
      if (index >= 0) turn.items[index] = item
      else turn.items.push(item)
      return
    }
    case 'notice':
      turn.items.push({
        type: 'notice',
        key: `notice:${turn.items.length}`,
        level: update.severity,
        text: update.description ? `${update.title}: ${update.description}` : update.title,
      })
      return
    case 'compaction_update': {
      const key = `compaction:${update.compactionId}`
      const item = { type: 'compaction' as const, key, status: update.status, error: update.error ?? null }
      const index = turn.items.findIndex(existing => existing.key === key)
      if (index >= 0) turn.items[index] = item
      else turn.items.push(item)
      return
    }
    default:
      return
  }
}

const emptyTurn = (id: string, status: TurnStatus, at: string | null = null): TurnView => ({
  id,
  origin: null,
  label: null,
  prompt: [],
  status,
  stopReason: null,
  error: null,
  items: [],
  queuedAt: at,
  startedAt: null,
  endedAt: null,
})

/** Fold a journal into turns. Pure; callers memoize on the journal version. */
export function transcript(entries: readonly ChatEntry[], truncated = false): Transcript {
  const turns: TurnView[] = []
  const byId = new Map<string, TurnView>()
  let historyTurn: TurnView | null = null
  let historyMessage: string | null = null
  const live = (id: string, at: string) => {
    let turn = byId.get(id)
    if (!turn) {
      // Its queued entry was dropped with older history.
      turn = emptyTurn(id, 'running', at)
      byId.set(id, turn)
      turns.push(turn)
    }
    return turn
  }
  const loose = (at: string) => {
    if (historyTurn) return historyTurn
    historyTurn = emptyTurn(`history:${turns.length}`, 'history', at)
    turns.push(historyTurn)
    return historyTurn
  }
  for (const entry of entries) {
    switch (entry.kind) {
      case 'queued': {
        const turn = emptyTurn(entry.turn, 'queued', entry.at)
        turn.origin = entry.origin
        turn.prompt = entry.prompt
        turn.label = labelOf(entry.origin, entry.prompt)
        byId.set(entry.turn, turn)
        turns.push(turn)
        historyTurn = null
        break
      }
      case 'unqueued':
        live(entry.turn, entry.at).status = 'removed'
        break
      case 'started': {
        const turn = live(entry.turn, entry.at)
        turn.status = 'running'
        turn.startedAt = entry.at
        break
      }
      case 'ended': {
        const turn = live(entry.turn, entry.at)
        turn.status = entry.stopReason === 'cancelled' ? 'cancelled' : entry.stopReason === 'error' ? 'error' : 'done'
        turn.stopReason = entry.stopReason
        turn.error = entry.error
        turn.endedAt = entry.at
        break
      }
      case 'history':
        historyTurn = null
        historyMessage = null
        break
      case 'update': {
        if (entry.turn) {
          applyUpdate(live(entry.turn, entry.at), entry.update, true)
          break
        }
        const { update } = entry
        if (update.sessionUpdate === 'user_message_chunk') {
          const id = update.messageId ?? null
          if (!historyTurn || historyTurn.items.length || id === null || id !== historyMessage) {
            historyTurn = emptyTurn(`history:${turns.length}`, 'history', entry.at)
            turns.push(historyTurn)
          }
          historyMessage = id
        }
        applyUpdate(loose(entry.at), update, false)
        break
      }
      case 'permission':
        live(entry.turn, entry.at).items.push({
          type: 'permission',
          key: `permission:${entry.id}`,
          id: entry.id,
          toolCall: entry.toolCall,
          options: entry.options,
          resolved: false,
          optionId: null,
        })
        break
      case 'resolved': {
        const turn = live(entry.turn, entry.at)
        const index = turn.items.findIndex(item => item.type === 'permission' && item.id === entry.id)
        if (index >= 0)
          turn.items[index] = {
            ...(turn.items[index] as Extract<TurnItem, { type: 'permission' }>),
            resolved: true,
            optionId: entry.optionId,
          }
        break
      }
      case 'notice': {
        const turn = entry.turn ? live(entry.turn, entry.at) : loose(entry.at)
        turn.items.push({ type: 'notice', key: `notice:${entry.seq}`, level: entry.level, text: entry.text })
        if (!entry.turn) historyTurn = null
        break
      }
    }
  }
  const pending = turns.flatMap(turn =>
    turn.items.filter(
      (item): item is Extract<TurnItem, { type: 'permission' }> => item.type === 'permission' && !item.resolved,
    ),
  )
  return {
    truncated,
    turns,
    queue: turns.filter(turn => turn.status === 'queued'),
    pending,
    running: turns.find(turn => turn.status === 'running') ?? null,
  }
}

/** The reply posted to a channel or another session: the turn's final assistant
 * message. Notes written between tool steps stay in the session's own chat. */
export function replyText(entries: readonly ChatEntry[], turn: string, limit = 16_000) {
  const messages: { id: string | null; text: string }[] = []
  for (const entry of entries) {
    if (entry.kind !== 'update' || entry.turn !== turn || entry.update.sessionUpdate !== 'agent_message_chunk') continue
    const { content, messageId } = entry.update
    if (content.type !== 'text') continue
    const id = messageId ?? null
    const last = messages.at(-1)
    if (last && last.id === id) last.text += content.text
    else messages.push({ id, text: content.text })
  }
  const text =
    [...messages]
      .reverse()
      .find(message => message.text.trim())
      ?.text.trim() ?? ''
  return text.length > limit ? `${text.slice(0, limit)}\n\n[Reply truncated by Outpost.]` : text
}
