// Messages for a terminal session (from other sessions, channels and schedules),
// typed into the coding tool when that cannot get in the user's way: the agent
// is idle, nobody has a draft or an unfinished line, and nobody typed for a few seconds. Kept in
// ~/.outpost/deliveries/<session>.json, so they outlive the node and a restart.
import type { SessionActivity } from '../shared/activity'
import { readJson, statePath, writeJson } from './state'

export interface Delivery {
  /** The server's key for it; adding the same key again changes nothing. */
  key: string
  text: string
  state: 'waiting' | 'typed' | 'done' | 'failed'
  /** The agent's last message when its turn for this one ended. */
  reply: string | null
  error: string | null
  /** You chose Deliver now: it goes in once the agent is idle, even in manual mode. */
  forced: boolean
  typedAt: number | null
  /** The agent started working on it. */
  started: boolean
}

interface Options {
  mode(): 'auto' | 'manual'
  activity(): SessionActivity
  /** Paste the message and press Enter. */
  type(text: string): void
  /** The agent's last message in the conversation, read from its transcript. */
  reply(): string | null
  /** The number of messages waiting changed. */
  changed(waiting: number): void
  now?: () => number
}

/** Quiet time after your last keystroke before a message goes in. */
export const typingPause = 3000
/** A typed message that never starts a turn (a menu was open, say) gives up after this. */
const startLimit = 60_000
const kept = 50

export class Deliveries {
  private items: Delivery[]
  private lastInput = 0
  /** You typed into the tool's input without pressing Enter yet. */
  private lineOpen = false
  /** Viewers with a draft in their message box. */
  private drafts = new Set<unknown>()
  private now: () => number
  private waiting = -1

  constructor(
    private session: string,
    private options: Options,
  ) {
    this.now = options.now ?? Date.now
    this.items = readJson<{ items: Delivery[] } | null>(this.path, null)?.items ?? []
  }

  private get path() {
    return statePath('deliveries', `${this.session}.json`)
  }

  private save() {
    const finished = this.items.filter(item => item.state === 'done' || item.state === 'failed')
    if (finished.length > kept) {
      const drop = new Set(finished.slice(0, finished.length - kept))
      this.items = this.items.filter(item => !drop.has(item))
    }
    writeJson(this.path, { items: this.items })
    const waiting = this.items.filter(item => item.state === 'waiting').length
    if (waiting !== this.waiting) {
      this.waiting = waiting
      this.options.changed(waiting)
    }
  }

  get count() {
    return this.items.filter(item => item.state === 'waiting').length
  }

  /** Queue a message; a key seen before returns its current state. */
  add(key: string, text: string) {
    let item = this.items.find(entry => entry.key === key)
    if (!item) {
      item = { key, text, state: 'waiting', reply: null, error: null, forced: false, typedAt: null, started: false }
      this.items.push(item)
      this.save()
    }
    this.tick()
    return item
  }

  status(keys: string[]) {
    return keys.flatMap(key => this.items.filter(item => item.key === key))
  }

  /** You typed into the terminal. Text without Enter (or Ctrl+C, Ctrl+U) leaves a
   * line open, which a message must not be pasted onto. */
  input(data: string | Buffer) {
    this.lastInput = this.now()
    const text = String(data)
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index)
      if (code === 0x1b) {
        // An escape sequence (arrows, function keys, focus reports) types nothing.
        if (text[index + 1] === '[') {
          index += 2
          while (index < text.length && !(text.charCodeAt(index) >= 0x40 && text.charCodeAt(index) <= 0x7e)) index++
        } else index++
      } else if (code === 0x0d || code === 0x0a || code === 0x03 || code === 0x15) this.lineOpen = false
      else if (code >= 0x20 && code !== 0x7f) this.lineOpen = true
    }
  }

  draft(viewer: unknown, active: boolean) {
    if (active) this.drafts.add(viewer)
    else this.drafts.delete(viewer)
    this.tick()
  }

  /** Deliver the next waiting message once the agent is idle, whatever the mode. */
  deliverNow() {
    const next = this.items.find(item => item.state === 'waiting')
    if (next) next.forced = true
    this.lastInput = 0
    this.tick()
  }

  /** The coding tool exited: what was typed and not answered failed. */
  exited() {
    for (const item of this.items)
      if (item.state === 'typed')
        Object.assign(item, { state: 'failed', error: 'The coding tool exited before replying.' })
    this.save()
  }

  /** Advance: settle the message in progress, or type the next one if nothing is in the way. */
  tick() {
    const activity = this.options.activity()
    const typed = this.items.find(item => item.state === 'typed')
    if (typed) {
      if (activity.state === 'working' || activity.state === 'waiting') {
        if (!typed.started) Object.assign(typed, { started: true })
        return
      }
      if (!typed.started) {
        if (this.now() - typed.typedAt! > startLimit)
          this.settle(typed, 'failed', 'The coding tool did not start working on the message.')
        return
      }
      if (activity.state === 'finished') this.settle(typed, 'done', null, this.options.reply())
      else if (activity.state === 'error') this.settle(typed, 'failed', activity.detail ?? 'The turn failed.')
      else if (activity.state === 'idle') this.settle(typed, 'failed', 'The turn was interrupted.')
      return
    }
    const next = this.items.find(item => item.state === 'waiting')
    if (!next || (this.options.mode() === 'manual' && !next.forced)) return
    if (activity.state !== 'idle' && activity.state !== 'finished') return
    if (!next.forced && (this.drafts.size || this.lineOpen)) return
    if (this.now() - this.lastInput < typingPause) return
    Object.assign(next, { state: 'typed', typedAt: this.now() })
    this.save()
    this.options.type(next.text)
  }

  private settle(item: Delivery, state: 'done' | 'failed', error: string | null, reply: string | null = null) {
    Object.assign(item, { state, error, reply })
    this.save()
    this.tick()
  }
}
