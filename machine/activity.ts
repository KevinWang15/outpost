// A session's activity, owned by its driver while it runs. The terminal service
// reads OSC 7501 Program Status reports directly from the PTY; the chat host
// derives it from ACP. Both persist the last state and seen completions so an
// unread reply or error survives after the driver exits.
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { parseSessionActivity, type ActivityState, type SessionActivity } from '../shared/activity'
import type { SessionRecord } from '../shared/model'
import type { BlockedKind, ProgramStatusReport, ProgramStatusState } from '../shared/programStatus'
import type { Harness } from './harnesses/harness'
import { recordEvent } from './events'
import { changeRegistry, switchConversation } from './registry'
import { readJson, statePath, writeJson } from './state'
import { reverseRecords, Scan } from './stores'

interface ActivityRecord {
  /** The current conversation when it was saved. */
  conversation: string
  last: SessionActivity
  /** Completion IDs the user has seen, newest last. */
  seen: string[]
}

interface ProgramRecord {
  state: Exclude<ProgramStatusState, 'clear'>
  kind: BlockedKind | null
  progress: number | null
  app: string | null
  title: string | null
  msg: string | null
  at: string
}

interface CompletionRecord {
  id: string
  at: string
  detail: string | null
}

const recordPath = (session: string) => statePath('activity', `${session}.json`)

export function readActivity(session: string): ActivityRecord | null {
  try {
    const raw = readJson<ActivityRecord | null>(recordPath(session), null)
    if (!raw || typeof raw !== 'object' || typeof raw.conversation !== 'string' || !Array.isArray(raw.seen)) return null
    const last = parseSessionActivity(raw.last)
    if (!last) return null
    return {
      conversation: raw.conversation,
      last,
      seen: raw.seen.filter((id): id is string => typeof id === 'string'),
    }
  } catch {
    return null // Derived state; a damaged or outdated file reads as no record.
  }
}

/** Save the session's activity; a change of state is also recorded for Outpost. */
export function saveActivity(session: string, record: ActivityRecord) {
  const previous = readActivity(session)?.last.state ?? null
  writeJson(recordPath(session), { ...record, seen: record.seen.slice(-64) })
  if (record.last.state !== previous)
    recordEvent({ type: 'activity', session, state: record.last.state, previous, detail: record.last.detail })
}

export function activity(
  state: ActivityState,
  options: {
    blockedKind?: BlockedKind | null
    progress?: number | null
    updatedAt?: string | null
    observedAt?: string | null
    completionId?: string | null
    detail?: string | null
  } = {},
): SessionActivity {
  return {
    state,
    blockedKind: state === 'waiting' ? (options.blockedKind ?? null) : null,
    progress: state === 'working' || state === 'waiting' ? (options.progress ?? null) : null,
    updatedAt: options.updatedAt ?? null,
    completionId: state === 'finished' ? (options.completionId ?? null) : null,
    detail: options.detail ? options.detail.slice(0, 4096) : null,
    observation: 'current',
    observedAt: options.observedAt ?? new Date().toISOString(),
  }
}

export function sameActivity(a: SessionActivity, b: SessionActivity): boolean {
  return (
    a.state === b.state &&
    a.blockedKind === b.blockedKind &&
    a.progress === b.progress &&
    a.completionId === b.completionId &&
    a.detail === b.detail
  )
}

/** What a session with no running driver shows: its unread reply or error, if any. */
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

const programToActivity: Record<Exclude<ProgramStatusState, 'clear'>, ActivityState> = {
  idle: 'idle',
  working: 'working',
  done: 'finished',
  blocked: 'waiting',
  error: 'error',
}

function formatDetail(title: string | null, msg: string | null): string | null {
  if (title && msg && title !== msg) return `${title}: ${msg}`
  return msg ?? title
}

/** The terminal service's view of its session's turn state, driven by OSC 7501. */
export class TerminalActivity {
  private readonly instance = randomUUID()
  private conversation: string
  private root: ProgramRecord | null = null
  private doneSeq = 0
  private completion: CompletionRecord | null = null
  private seen: string[]
  private running = true
  private value: SessionActivity

  constructor(
    private session: SessionRecord,
    conversation: string,
    private harness: Harness,
    private changed: (value: SessionActivity) => void,
  ) {
    this.conversation = conversation
    this.seen = readActivity(session.id)?.seen ?? []
    this.value = activity('idle')
  }

  get current() {
    return this.value
  }

  get currentConversation() {
    return this.conversation
  }

  private completionId(seq: number) {
    return createHash('sha256').update(`${this.session.id}:${this.conversation}:${this.instance}:${seq}`).digest('hex')
  }

  /** Apply one validated OSC 7501 program status report. */
  reportStatus(report: ProgramStatusReport) {
    // Sub-task reports (with an `id`) never affect the session's root turn state.
    if (report.id !== null) return

    if (report.state === 'clear') {
      this.root = null
      this.completion = null
      this.publish()
      return
    }

    const at = new Date().toISOString()
    if (report.state === 'done') {
      const detail = formatDetail(report.title, report.msg)
      // Repeated `done` reports for the same completion keep the same completionId.
      if (this.root?.state !== 'done' || !this.completion) {
        this.doneSeq++
        this.completion = { id: this.completionId(this.doneSeq), at, detail }
      } else {
        this.completion = { id: this.completion.id, at, detail }
      }
    } else if (report.state !== 'idle') {
      // Latch an unacknowledged `done` across a subsequent `idle` report; only a new
      // active/error/clear state or user acknowledgement clears it.
      this.completion = null
    }

    this.root = {
      state: report.state,
      kind: report.kind,
      progress: report.progress,
      app: report.app,
      title: report.title,
      msg: report.msg,
      at,
    }
    this.publish()
  }

  private derive(): SessionActivity {
    const root = this.root
    if (!root) return activity('idle')
    const state = programToActivity[root.state]
    if (!this.running && (state === 'working' || state === 'waiting')) return activity('idle', { updatedAt: root.at })
    if (state === 'finished' || state === 'idle') {
      if (this.completion && !this.seen.includes(this.completion.id)) {
        return activity('finished', {
          updatedAt: this.completion.at,
          completionId: this.completion.id,
          detail: this.completion.detail,
        })
      }
      return activity('idle', {
        updatedAt: root.at,
        detail: state === 'idle' ? formatDetail(root.title, root.msg) : null,
      })
    }
    return activity(state, {
      blockedKind: root.kind,
      progress: root.progress,
      updatedAt: root.at,
      detail: formatDetail(root.title, root.msg),
    })
  }

  private publish() {
    const next = this.derive()
    if (sameActivity(next, this.value)) return
    this.value = next
    saveActivity(this.session.id, { conversation: this.conversation, last: next, seen: this.seen })
    this.changed(next)
  }

  /** Minimal session-identity hook relayed by `outpost-terminal hook`. Updates
   * which native conversation this session resumes if the user ran `/new` or
   * `/resume` inside the tool; never alters turn activity. */
  async sessionEvent(raw: Record<string, unknown>) {
    const payload = this.harness.hookPayload(this.session, raw)
    if (!payload) return
    const native = payload.session_id
    const event = payload.hook_event_name
    if (typeof event !== 'string' || !this.harness.validId(native)) return
    if (
      (payload.agent_id !== undefined && payload.agent_id !== null && payload.agent_id !== 'main') ||
      payload.isSidechain
    )
      return
    if (event !== 'SessionStart' && event !== 'UserPromptSubmit') return
    if (event === 'SessionStart' && payload.source === 'compact') return
    if (native === this.conversation) return
    this.conversation = native
    await changeRegistry(registry => switchConversation(registry, this.session.id, native)).catch(() => {})
  }

  /** The agent's newest message in the current conversation, read on demand
   * from its transcript when a delivered message finishes. */
  lastReply(limit = 16_000) {
    if (!this.conversation) return null
    let path: string | null
    try {
      path = this.harness.transcript(this.session, this.conversation)
    } catch {
      return null
    }
    if (!path) return null
    let size: number
    try {
      size = lstatSync(path).size
    } catch {
      return null
    }
    let format = ''
    try {
      format = this.harness.historySession(path, this.harness.storeOf(this.session), new Scan(), new Map()).format
    } catch {
      /* Fall back to default format if metadata is not yet present. */
    }
    let records = 0
    for (const { record } of reverseRecords(path, size)) {
      if (++records > 2000) break
      for (const message of this.harness.historyMessages(record, format))
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
  }
}

/** Keys the user typed, as opposed to a focus report the terminal sends by itself. */
export const isUserInput = (data: Buffer) =>
  data.length > 0 && !data.equals(Buffer.from('\x1b[I')) && !data.equals(Buffer.from('\x1b[O'))
