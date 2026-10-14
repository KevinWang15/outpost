import type { HistoryAction, ScrollbackState } from '../../shared/protocol'
import { terminalKey } from './keys'
import type { TerminalSocket } from './socket'

/** Shared history behavior for keyboard and sidebar controls. The harness
 * advertises application navigation; otherwise tmux owns the scroll position. */
export class TerminalHistory {
  private state: ScrollbackState | null = null

  constructor(
    private client: Pick<TerminalSocket, 'input' | 'scrollTo'>,
    private changed: (state: ScrollbackState | null) => void,
  ) {}

  update(state: ScrollbackState | null) {
    this.state = state
    this.changed(state)
  }

  scrollTo(offset: number) {
    if (this.state) {
      // Keep rapid page presses relative to the most recent destination.
      this.state = { ...this.state, offset: offset === -1 ? this.state.lines : offset }
    }
    this.client.scrollTo(offset)
  }

  navigate(action: HistoryAction) {
    const binding = this.state?.navigation?.keys[action]
    if (binding) this.client.input(terminalKey(binding.key, binding)!)
  }

  handleKey(event: KeyboardEvent) {
    const state = this.state
    if (
      event.type !== 'keydown' ||
      !event.shiftKey ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      (event.key !== 'PageUp' && event.key !== 'PageDown') ||
      (!state?.available && !state?.navigation)
    )
      return false
    event.preventDefault()
    if (state.navigation && !state.active) this.navigate(event.key === 'PageUp' ? 'pageUp' : 'pageDown')
    else {
      const page = Math.max(1, state.rows - 1)
      this.scrollTo(Math.max(0, Math.min(state.lines, state.offset + (event.key === 'PageUp' ? page : -page))))
    }
    return true
  }
}
