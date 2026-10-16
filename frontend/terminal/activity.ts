import type { SessionActivity } from '../../shared/activity'
import type { TerminalConnection } from './connection'

/** Acknowledge the completion visible on activation, never a later turn.
 * Keep local feedback immediate while the target persists the shared check. */
export class TerminalActivity {
  private state: SessionActivity | null = null
  private active = false
  private awaitingObservation = false
  private generation = 0
  private pending = new Set<string>()
  private checked = new Set<string>()

  constructor(
    private client: Pick<TerminalConnection, 'acknowledge'>,
    private changed: (state: SessionActivity | null) => void,
    private notice: (message: string) => void,
  ) {}

  update(state: SessionActivity | null) {
    this.state = state
    if (state === null) {
      this.generation++
      this.pending.clear()
      this.checked.clear()
      this.awaitingObservation = this.active
    }
    if (state && this.awaitingObservation) this.acknowledge()
    this.publish()
  }

  setActive(active: boolean) {
    if (this.active === active) return
    this.active = active
    if (active) this.acknowledge()
    else this.awaitingObservation = false
  }

  acknowledge() {
    if (!this.active || !this.client.acknowledge) return
    this.awaitingObservation = this.state === null
    const token = this.state?.state === 'finished' ? this.state.completionId : null
    if (!token || this.checked.has(token) || this.pending.has(token) || this.pending.size >= 32) return
    const generation = this.generation
    this.pending.add(token)
    this.publish()
    void this.client.acknowledge(token).then(
      () => {
        if (generation !== this.generation) return
        this.pending.delete(token)
        this.checked.add(token)
        if (this.checked.size > 32) this.checked.delete(this.checked.values().next().value!)
        this.publish()
      },
      error => {
        if (generation !== this.generation) return
        this.pending.delete(token)
        this.publish()
        this.notice(`Could not mark this completion as seen: ${(error as Error).message}`)
      },
    )
  }

  private publish() {
    const state = this.state
    const token = state?.state === 'finished' ? state.completionId : null
    this.changed(
      token && (this.pending.has(token) || this.checked.has(token))
        ? { ...state!, state: 'idle', completionId: null }
        : state,
    )
  }

  dispose() {
    this.generation++
    this.active = false
  }
}
