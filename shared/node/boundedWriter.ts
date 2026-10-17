import type { Writable } from 'node:stream'

/** A byte-bounded FIFO. A false write pauses admission to the stream until
 * drain; overflow or a stalled consumer fails the owner instead of losing input. */
export class BoundedWriter {
  private queue: (Buffer | undefined)[] = []
  private first = 0
  private bytes = 0
  private blocked = false
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private stream: Writable,
    private limit: number,
    private stallMs: number,
    private failed: (message: string) => void,
  ) {
    stream.on('drain', this.drain)
  }

  write(data: Buffer) {
    if (this.disposed) return false
    if (!this.stream.writable || this.bytes + this.stream.writableLength + data.length > this.limit) {
      this.fail('Terminal input is backed up. Check the terminal before reconnecting; unsent input is not retried.')
      return false
    }
    if (this.blocked) {
      this.queue.push(data)
      this.bytes += data.length
    } else this.flush(data)
    return !this.disposed
  }

  private flush(data: Buffer) {
    if (this.stream.write(data)) return
    this.blocked = true
    this.timer = setTimeout(
      () => this.fail('The target stopped accepting input. Check the terminal before reconnecting.'),
      this.stallMs,
    )
    this.timer.unref()
  }

  private drain = () => {
    clearTimeout(this.timer)
    this.timer = undefined
    this.blocked = false
    while (!this.disposed && !this.blocked && this.first < this.queue.length) {
      const data = this.queue[this.first]!
      this.queue[this.first++] = undefined
      this.bytes -= data.length
      this.flush(data)
    }
    if (this.first === this.queue.length || this.first >= 1024) {
      this.queue = this.queue.slice(this.first)
      this.first = 0
    }
  }

  private fail(message: string) {
    if (this.disposed) return
    this.dispose()
    this.failed(message)
  }

  dispose() {
    this.disposed = true
    clearTimeout(this.timer)
    this.stream.off('drain', this.drain)
    this.queue = []
    this.first = 0
    this.bytes = 0
  }
}
