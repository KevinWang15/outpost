import { Duplex } from 'node:stream'
import { FrameDecoder, maxTerminalFrame, terminalControl, terminalFrame } from '../shared/node/terminalFrames'

/** The same framed byte stream as a driver socket, for a view of the other interface. */
export abstract class ViewStream extends Duplex {
  private decoder = new FrameDecoder()
  constructor() {
    super({ allowHalfOpen: false })
  }

  protected control(message: object) {
    this.output(terminalControl(message))
  }
  protected display(text: string) {
    this.output(terminalFrame('O', Buffer.from(text)))
  }

  private output(packet: Buffer) {
    if (this.destroyed || this.readableEnded) return
    if (this.readableLength + packet.length > maxTerminalFrame + 5) this.destroy()
    else this.push(packet)
  }

  protected abstract receive(kind: string, payload: Buffer): void | Promise<void>
  override _read() {}
  override _write(bytes: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    const read = async () => {
      for (const frame of this.decoder.feed(bytes)) await this.receive(frame.kind, frame.payload)
    }
    read().then(() => done(), done)
  }
  override _final(done: () => void) {
    this.push(null)
    done()
  }
}
