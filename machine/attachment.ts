import type { Socket } from 'node:net'
import { setImmediate } from 'node:timers/promises'
import type { Checkpoint } from '../shared/terminalState'
import { terminalControl } from '../shared/node/terminalFrames'

const maxPending = 8 * 1024 * 1024
const sliceMs = 4

/** A snapshot precedes this viewer's live stream. Slow viewers never pause the
 * persistent PTY: bounded catch-up/socket queues disconnect them if necessary. */
export class TerminalAttachment {
  private restoring = true
  private ending = false
  private pending: (Buffer | undefined)[] = []
  private pendingBytes = 0

  constructor(private socket: Socket) {
    socket.once('close', () => {
      this.pending = []
      this.pendingBytes = 0
    })
  }

  output(packet: Buffer) {
    if (this.ending || this.socket.destroyed) return
    if (this.restoring) {
      if (this.pendingBytes + packet.length > maxPending) return this.socket.destroy()
      this.pending.push(packet)
      this.pendingBytes += packet.length
    } else {
      if (this.socket.writableLength + packet.length > maxPending) return this.socket.destroy()
      this.socket.write(packet)
    }
  }

  /** Exit belongs after the snapshot and all accepted output, including when
   * the child finishes while this viewer is still restoring its history. */
  end() {
    if (this.ending) return
    this.output(terminalControl({ type: 'exit', reason: 'ended' }))
    this.ending = true
    if (!this.restoring && !this.socket.destroyed) this.socket.end()
  }

  async restore(parts: Generator<Checkpoint>) {
    let until = performance.now() + sliceMs
    const write = async (packet: Buffer) => {
      if (this.socket.destroyed) throw new Error('Terminal viewer disconnected')
      if (!this.socket.write(packet)) await this.drain()
      if (performance.now() >= until) {
        await setImmediate()
        until = performance.now() + sliceMs
      }
    }
    try {
      for (const part of parts) await write(terminalControl({ type: 'restore', checkpoint: part }))
      // Enable input as soon as the snapshot is complete, even if output is
      // still catching up. In particular, Ctrl+C must be able to stop a flood.
      await write(terminalControl({ type: 'ready' }))
      // Output and geometry received while streaming the snapshot follow it in
      // their original order. Release each packet as it enters the socket.
      let first = 0
      while (first < this.pending.length) {
        const packet = this.pending[first]!
        this.pending[first++] = undefined
        this.pendingBytes -= packet.length
        await write(packet)
        if (first >= 1024) {
          this.pending = this.pending.slice(first)
          first = 0
        }
      }
      this.pending = []
      this.restoring = false
      if (this.ending && !this.socket.destroyed) this.socket.end()
    } finally {
      parts.return(undefined)
    }
  }

  private drain() {
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer)
        this.socket.off('drain', drained)
        this.socket.off('close', closed)
        this.socket.off('error', failed)
        if (error) reject(error)
        else resolve()
      }
      const drained = () => finish()
      const closed = () => finish(new Error('Terminal viewer disconnected'))
      const failed = (error: Error) => finish(error)
      const timer = setTimeout(() => {
        finish(new Error('Terminal viewer stopped reading its snapshot'))
        this.socket.destroy()
      }, 30_000)
      this.socket.once('drain', drained)
      this.socket.once('close', closed)
      this.socket.once('error', failed)
      if (this.socket.destroyed) closed()
    })
  }
}
