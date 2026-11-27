import type { SessionActivity } from '../activity'
import type { TerminalSocket } from './socket'

/** Acknowledge the completion visible on activation, never a later turn.
 * Discard late replies after reconnect and suppress duplicate acknowledgements. */
export class TerminalActivity {
  private state: SessionActivity | null = null
  private active = false
  private awaitingObservation = false
  private generation = 0
  private pending = new Set<string>()
  private checked = new Set<string>()

  constructor(
    private client: Pick<TerminalSocket, 'acknowledge'>,
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
  }

  setActive(active: boolean) {
    if (this.active === active) return
    this.active = active
    if (active) this.acknowledge()
    else this.awaitingObservation = false
  }

  acknowledge() {
    if (!this.active) return
    if (this.state && this.state.observation !== 'current') {
      this.awaitingObservation = true
      return
    }
    this.awaitingObservation = this.state === null
    const token = this.state?.state === 'finished' ? this.state.completionId : null
    if (!token || this.checked.has(token) || this.pending.has(token) || this.pending.size >= 32) return
    const generation = this.generation
    this.pending.add(token)
    void this.client.acknowledge(token).then(
      () => {
        if (generation !== this.generation) return
        this.pending.delete(token)
        this.checked.add(token)
        if (this.checked.size > 32) this.checked.delete(this.checked.values().next().value!)
      },
      error => {
        if (generation !== this.generation) return
        this.pending.delete(token)
        const reason = error instanceof Error ? error.message : String(error)
        this.notice(`Could not mark this completion as seen: ${reason}`)
      },
    )
  }

  dispose() {
    this.generation++
    this.active = false
  }
}
