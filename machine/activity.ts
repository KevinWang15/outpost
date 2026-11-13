// A session's activity, owned by its driver while it runs. The terminal service
// keeps it from the tool's hooks and its transcript; the chat host from ACP.
// Both save the last state and the completions already seen, so an unread
// reply is still reported after the driver exits.
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import type { ActivityState, SessionActivity } from '../shared/activity'
import type { SessionRecord } from '../shared/model'
import type { Harness, Marker } from './harnesses/harness'
import { turnId } from './harnesses/harness'
import { changeRegistry, switchConversation } from './registry'
import { readJson, statePath, writeJson } from './state'
import { lines, reverseRecords, timestamp } from './stores'

interface ActivityRecord {
  /** The current conversation when it was saved. */
  conversation: string
  last: SessionActivity
  /** Completion IDs the user has seen, newest last. */
  seen: string[]
}

const recordPath = (session: string) => statePath('activity', `${session}.json`)

export function readActivity(session: string): ActivityRecord | null {
  try {
    return readJson<ActivityRecord | null>(recordPath(session), null)
  } catch {
    return null // Derived state; a damaged file reads as no record.
  }
}
export const saveActivity = (session: string, record: ActivityRecord) =>
  writeJson(recordPath(session), { ...record, seen: record.seen.slice(-64) })

export function activity(
  state: ActivityState,
  updatedAt: string | null = null,
  completionId: string | null = null,
  detail: string | null = null,
): SessionActivity {
  return { state, updatedAt, completionId, detail, observation: 'current', observedAt: new Date().toISOString() }
}

/** What a session with no running driver shows: its unread reply, if any. */
export function restingActivity(session: string): SessionActivity {
  const record = readActivity(session)
  const last = record?.last
  if (last?.state === 'finished' && last.completionId && !record!.seen.includes(last.completionId)) return last
  if (last?.state === 'error') return last
  return activity('idle')
}

/** Mark a completion seen while no driver runs. */
export function acknowledgeResting(session: string, completionId: string) {
  const record = readActivity(session)
  if (!record || record.seen.includes(completionId)) return
  saveActivity(session, { ...record, seen: [...record.seen, completionId] })
}

const hookStates: Record<string, ActivityState> = {
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  ElicitationResult: 'working',
  PermissionRequest: 'waiting',
  Elicitation: 'waiting',
  StopFailure: 'error',
  Stop: 'finished',
  Interrupt: 'idle',
  SessionEnd: 'idle',
}

function hookState(event: string, payload: Record<string, unknown>): ActivityState | null {
  if (event === 'PostToolUseFailure')
    // A cancelled tool ends the turn; an ordinary failure is handled within it.
    return payload.is_interrupt === true ? 'idle' : 'working'
  if (event === 'Notification')
    return ['permission_prompt', 'elicitation_dialog'].includes(payload.notification_type as string) ? 'waiting' : null
  return hookStates[event] ?? null
}

interface Observation {
  state: ActivityState
  at: number
  turn: string | null
  /** Identifies a completion, so seeing it once clears it. */
  source: string
}

/** The terminal service's view of its session's turn state. */
export class TerminalActivity {
  private conversation: string
  private hook: Observation | null = null
  /** The transcript being followed: how far it was read, and its latest marker. */
  private followed: { path: string; identity: string; end: number; marker: Marker | null } | null = null
  /** Unchanged since launch: an old prompt or reply is not new activity. */
  private baseline: string | null = null
  private seen: string[]
  private running = true
  private value: SessionActivity
  private transcriptAt = 0
  private transcriptPath: string | null = null
  private timer: NodeJS.Timeout

  constructor(
    private session: SessionRecord,
    conversation: string,
    private harness: Harness,
    private changed: (value: SessionActivity) => void,
    private problem: string | null = null,
  ) {
    this.conversation = conversation
    this.seen = readActivity(session.id)?.seen ?? []
    this.read()
    this.settleBaseline()
    this.value = this.derive()
    this.timer = setInterval(() => this.refresh(), 1000)
    this.timer.unref()
  }

  get current() {
    return this.value
  }
  get currentConversation() {
    return this.conversation
  }

  /** A turn already finished at launch, or when switching to a conversation, was seen before. */
  private settleBaseline() {
    const marker = this.followed?.marker
    this.baseline = marker ? this.markerSource(marker) : null
    if (marker?.activity.state === 'finished') this.see(this.markerSource(marker))
  }

  private markerSource(marker: Marker) {
    return `transcript:${this.followed!.identity}:${marker.offset}`
  }

  private see(source: string) {
    const id = this.completionId(source)
    if (!this.seen.includes(id)) this.seen = [...this.seen, id].slice(-64)
  }

  private completionId(source: string) {
    return createHash('sha256').update(`${this.session.id}:${this.conversation}:${source}`).digest('hex')
  }

  /** Follow the current transcript: a full backwards read when it is new or
   * replaced, then only the records appended since. */
  private read() {
    const now = performance.now()
    if (!this.transcriptPath || now - this.transcriptAt > 10_000) {
      try {
        this.transcriptPath = this.harness.transcript(this.session, this.conversation)
      } catch {
        this.transcriptPath = null
      }
      this.transcriptAt = now
    }
    const path = this.transcriptPath
    if (!path) return
    let size: number, identity: string
    try {
      const info = lstatSync(path)
      size = info.size
      identity = `${info.dev}:${info.ino}`
    } catch {
      return
    }
    const followed = this.followed
    if (!followed || followed.path !== path || followed.identity !== identity || followed.end > size) {
      const end = completeEnd(path, size)
      this.followed = { path, identity, end, marker: this.harness.marker(reverseRecords(path, end)) }
      return
    }
    for (const { record, end } of lines(path, followed.end)) {
      if (record) followed.marker = this.harness.update(record, end, followed.marker, () => reverseRecords(path, end))
      followed.end = end
    }
  }

  private derive(): SessionActivity {
    const marker = this.followed?.marker
    const fromMarker: Observation | null = marker
      ? {
          state: marker.activity.state,
          at: Date.parse(timestamp(marker.activity.timestamp) ?? '') || 0,
          turn: marker.activity.turn,
          source: this.markerSource(marker),
        }
      : null
    let chosen: Observation | null = this.harness.hookStates ? this.hook : null
    if (!chosen) chosen = fromMarker
    else if (
      fromMarker &&
      (chosen.state === 'working' || chosen.state === 'waiting') &&
      ['idle', 'finished', 'error'].includes(fromMarker.state) &&
      fromMarker.at > chosen.at &&
      (chosen.turn === null || fromMarker.turn === chosen.turn)
    )
      // Recover a missed completion or interruption from a newer native record.
      chosen = fromMarker
    let state = chosen?.state ?? 'idle'
    // An old prompt left in the transcript is not a turn in progress.
    if (
      chosen === fromMarker &&
      chosen &&
      chosen.source === this.baseline &&
      (state === 'working' || state === 'waiting')
    )
      state = 'idle'
    if (!this.running && (state === 'working' || state === 'waiting')) state = 'idle'
    const updated = chosen?.at ? new Date(chosen.at).toISOString() : null
    if (state === 'finished') {
      const id = this.completionId(chosen!.source)
      if (this.seen.includes(id)) return activity('idle', updated, null, this.problem)
      return activity('finished', updated, id, this.problem)
    }
    return activity(
      state,
      updated,
      null,
      state === 'unknown' ? 'The coding tool is in a state Outpost cannot track.' : this.problem,
    )
  }

  /** Read what the tool wrote since; also runs every second. */
  refresh() {
    try {
      this.read()
    } catch {
      /* The next tick rereads; a missing transcript is not an error. */
    }
    this.publish()
  }

  private publish() {
    const next = this.derive()
    const same = (a: SessionActivity, b: SessionActivity) =>
      a.state === b.state && a.completionId === b.completionId && a.detail === b.detail && a.updatedAt === b.updatedAt
    const changed = !same(next, this.value)
    this.value = next
    if (changed) {
      saveActivity(this.session.id, { conversation: this.conversation, last: next, seen: this.seen })
      this.changed(next)
    }
  }

  /** A hook from the tool, relayed by `outpost-terminal hook`. */
  async hookEvent(payload: Record<string, unknown>) {
    const native = payload.session_id
    const event = payload.hook_event_name
    if (typeof event !== 'string' || !this.harness.validId(native)) return
    if (
      (payload.agent_id !== undefined && payload.agent_id !== null && payload.agent_id !== 'main') ||
      payload.isSidechain
    )
      return // Subagents are not the main turn.
    const binding = event === 'SessionStart' || event === 'UserPromptSubmit'
    if (native !== this.conversation && !binding) return // A late event from another conversation.
    if (event === 'SessionStart' && payload.source === 'compact') return
    const state = this.harness.hookStates ? hookState(event, payload) : null
    if (state === null && !binding) return
    const previous = this.hook?.state
    if (event === 'SessionEnd' && (previous === 'finished' || previous === 'error')) return
    if (state === 'finished' && previous === 'finished') return // A late Stop for the same reply.
    if (native !== this.conversation) {
      // New, clear or resume selected another conversation in the tool.
      this.conversation = native
      this.hook = null
      this.followed = null
      this.transcriptPath = null
      await changeRegistry(registry => switchConversation(registry, this.session.id, native)).catch(() => {})
      try {
        this.read()
      } catch {
        /* Read again on the next tick. */
      }
      this.settleBaseline()
    } else if (event === 'SessionStart') this.hook = null
    const turn = turnId(payload.turn_id)
    if (
      turn &&
      this.hook?.turn &&
      turn !== this.hook.turn &&
      (state === 'finished' || state === 'idle' || state === 'error')
    )
      return // The end of an older turn.
    if (state !== null) {
      const at = Date.now()
      this.hook = {
        state,
        at,
        turn: turn ?? (event === 'UserPromptSubmit' ? null : (this.hook?.turn ?? null)),
        source: `hook:${at}`,
      }
    } else if (event === 'SessionStart')
      this.hook = { state: 'idle', at: Date.now(), turn: null, source: `hook:${Date.now()}` }
    this.publish()
  }

  /** The agent's newest message in the current conversation, from its transcript. */
  lastReply(limit = 16_000) {
    // The turn may have ended before the transcript was next read (a new one appears with its first prompt).
    try {
      this.read()
    } catch {
      /* Read what was found before. */
    }
    const path = this.followed?.path
    if (!path) return null
    let size: number
    try {
      size = lstatSync(path).size
    } catch {
      return null
    }
    let records = 0
    for (const { record } of reverseRecords(path, completeEnd(path, size))) {
      if (++records > 2000) break
      for (const message of this.harness.historyMessages(record, ''))
        if (message.role === 'assistant' && message.kind === 'message' && message.text.trim())
          return message.text.slice(0, limit)
    }
    return null
  }

  /** The user typed into the terminal: a shown reply is now seen. */
  input() {
    if (this.value.state === 'finished' && this.value.completionId) this.acknowledge(this.value.completionId)
  }

  acknowledge(completionId: string) {
    if (this.value.completionId !== completionId) return false
    this.seen = [...this.seen, completionId].slice(-64)
    this.publish()
    return true
  }

  exited() {
    this.running = false
    this.publish()
    clearInterval(this.timer)
  }
}

/** Keys the user typed, as opposed to a focus report the terminal sends by itself. */
export const isUserInput = (data: Buffer) =>
  data.length > 0 && !data.equals(Buffer.from('\x1b[I')) && !data.equals(Buffer.from('\x1b[O'))

/** The end of the last complete line, skipping a record still being written. */
function completeEnd(path: string, size: number) {
  const descriptor = openSync(path, 'r')
  try {
    let position = Math.min(size, fstatSync(descriptor).size)
    const block = Buffer.alloc(64 * 1024)
    while (position > 0) {
      const length = Math.min(block.length, position)
      readSync(descriptor, block, 0, length, position - length)
      const newline = block.subarray(0, length).lastIndexOf(10)
      if (newline >= 0) return position - length + newline + 1
      position -= length
    }
    return 0
  } finally {
    closeSync(descriptor)
  }
}
