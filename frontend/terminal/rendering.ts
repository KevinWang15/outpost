import type { Terminal } from '@xterm/xterm'
import type { ServerMessage } from '../../shared/protocol'
import { CheckpointReader, remoteTerminalReplies } from '../../shared/terminalCheckpoint'
import { terminalSize } from '../../shared/terminalService'

type RestoreMessage = Extract<ServerMessage, { type: 'restore' | 'geometry' }>
const maxWriteBatch = 128 * 1024
interface WriteBatch {
  chunks: Uint8Array[]
  bytes: number
  acknowledged: (() => void)[]
}

/** Connections order output and geometry, then acknowledge completed rendering.
 * Remote attachments additionally restore a checkpoint before live output. */
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
  private pendingWrite: WriteBatch | null = null
  private generation = 0
  private stopped = false
  private disposed = false
  private checkpoints: CheckpointReader
  private phase: 'waiting' | 'restoring' | 'live' = 'waiting'

  constructor(
    private terminal: Terminal,
    private failed: (message: string) => void,
    private local = false,
  ) {
    this.checkpoints = new CheckpointReader(terminal)
    if (!local) remoteTerminalReplies(terminal)
  }

  get restoring() {
    return this.phase === 'restoring'
  }

  begin() {
    this.generation++
    this.pendingWrite = null
    this.stopped = false
    this.phase = this.local ? 'live' : 'waiting'
    this.checkpoints = new CheckpointReader(this.terminal)
    if (this.local)
      this.enqueue(
        () => this.terminal.reset(),
        () => {},
      )
  }

  output(bytes: Uint8Array, rendered: () => void) {
    // Let output arriving during an in-flight write accumulate into the next
    // bounded batch. Never make xterm schedule a separate timer for each tiny
    // network frame, and never combine bytes across a resize/checkpoint barrier.
    const pending = this.pendingWrite
    if (pending && pending.bytes + bytes.length <= maxWriteBatch) {
      pending.chunks.push(bytes)
      pending.bytes += bytes.length
      pending.acknowledged.push(rendered)
      return
    }
    const batch: WriteBatch = { chunks: [bytes], bytes: bytes.length, acknowledged: [rendered] }
    this.pendingWrite = batch
    this.enqueue(
      () => {
        if (this.pendingWrite === batch) this.pendingWrite = null
        if (this.phase !== 'live') throw new Error('Live output arrived before restoration finished')
        let data = batch.chunks[0]
        if (batch.chunks.length > 1) {
          data = new Uint8Array(batch.bytes)
          let offset = 0
          for (const chunk of batch.chunks) {
            data.set(chunk, offset)
            offset += chunk.length
          }
        }
        return new Promise<void>(resolve => this.terminal.write(data, resolve))
      },
      () => {
        for (const acknowledge of batch.acknowledged) acknowledge()
      },
    )
  }

  restore(message: RestoreMessage, rendered: () => void) {
    this.pendingWrite = null
    this.enqueue(() => {
      if (message.type === 'geometry') {
        if (this.phase !== 'live' || !terminalSize(message.cols, message.rows))
          throw new Error('Invalid terminal geometry')
        this.terminal.resize(message.cols, message.rows)
        this.terminal.refresh(0, this.terminal.rows - 1)
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
    this.pendingWrite = null
    this.enqueue(() => {
      if (this.phase !== 'live') throw new Error('Incomplete terminal checkpoint')
    }, rendered)
  }

  dispose() {
    this.pendingWrite = null
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
