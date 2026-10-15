import type { Terminal } from '@xterm/xterm'
import type { ServerMessage } from '../../shared/protocol'
import { CheckpointReader, remoteTerminalReplies } from '../../shared/terminalCheckpoint'
import { terminalSize } from '../../shared/terminalService'

type RestoreMessage = Extract<ServerMessage, { type: 'restore' | 'geometry' }>

/** Every connection must restore checkpoints and acknowledge completed rendering. */
export interface TerminalRendering {
  begin(): void
  output(bytes: Uint8Array, rendered: () => void): void
  restore(message: RestoreMessage, rendered: () => void): void
  flush(rendered: () => void): void
}

/** One ordered queue for writes, checkpoints, geometry and the ready barrier.
 * Connection generations discard stale queued work while preserving ordering
 * behind an in-flight xterm write. Disposal never acknowledges unfinished work. */
export class TerminalRenderer implements TerminalRendering {
  private queue = Promise.resolve()
  private generation = 0
  private stopped = false
  private disposed = false
  private checkpoints: CheckpointReader
  private phase: 'waiting' | 'restoring' | 'live' = 'waiting'

  constructor(
    private terminal: Terminal,
    private failed: (message: string) => void,
  ) {
    this.checkpoints = new CheckpointReader(terminal)
    remoteTerminalReplies(terminal)
  }

  get restoring() {
    return this.phase === 'restoring'
  }

  begin() {
    this.generation++
    this.stopped = false
    this.phase = 'waiting'
    this.checkpoints = new CheckpointReader(this.terminal)
  }

  output(bytes: Uint8Array, rendered: () => void) {
    this.enqueue(() => {
      if (this.phase !== 'live') throw new Error('Live output arrived before restoration finished')
      return new Promise<void>(resolve => this.terminal.write(bytes, resolve))
    }, rendered)
  }

  restore(message: RestoreMessage, rendered: () => void) {
    this.enqueue(() => {
      if (message.type === 'geometry') {
        if (this.phase !== 'live' || !terminalSize(message.cols, message.rows))
          throw new Error('Invalid terminal geometry')
        this.terminal.resize(message.cols, message.rows)
      } else {
        if (message.checkpoint.part === 'begin') {
          if (this.phase !== 'waiting') throw new Error('Unexpected terminal checkpoint')
          this.phase = 'restoring'
        } else if (!this.restoring) throw new Error('Missing terminal checkpoint header')
        this.checkpoints.accept(message.checkpoint)
        if (message.checkpoint.part === 'end') this.phase = 'live'
      }
    }, rendered)
  }

  flush(rendered: () => void) {
    this.enqueue(() => {
      if (this.phase !== 'live') throw new Error('Incomplete terminal checkpoint')
    }, rendered)
  }

  dispose() {
    this.disposed = true
    this.generation++
  }

  private enqueue(operation: () => void | Promise<void>, rendered: () => void) {
    const generation = this.generation
    const current = () => !this.disposed && !this.stopped && generation === this.generation
    this.queue = this.queue
      .then(() => {
        if (current()) return operation()
      })
      .then(() => {
        if (current()) rendered()
      })
      .catch(error => {
        if (!current()) return
        this.stopped = true
        this.failed(`Could not render the terminal: ${(error as Error).message}`)
      })
  }
}
