import { Buffer } from 'node:buffer'

/** One codec for the broker, relay and terminal service byte streams. */
export const relayMagic = Buffer.from('\0OUTPOST-RELAY-2\0', 'latin1')
export const maxTerminalFrame = 32 * 1024 * 1024
type FrameKind = 'I' | 'O' | 'C'
const validKind = (kind: string): kind is FrameKind => kind === 'I' || kind === 'O' || kind === 'C'

export function terminalFrame(kind: FrameKind, payload: Buffer) {
  if (!validKind(kind) || payload.length > maxTerminalFrame) throw new Error('Invalid terminal frame')
  const header = Buffer.alloc(5)
  header.write(kind, 0, 'ascii')
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

export const terminalControl = (message: object) => terminalFrame('C', Buffer.from(JSON.stringify(message)))

export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0)
  feed(data: Buffer): { kind: FrameKind; payload: Buffer }[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, data]) : data
    const frames = []
    while (this.pending.length >= 5) {
      const kind = this.pending.toString('latin1', 0, 1)
      const size = this.pending.readUInt32BE(1)
      if (!validKind(kind) || size > maxTerminalFrame) throw new Error('Invalid terminal frame')
      if (this.pending.length < size + 5) break
      frames.push({ kind, payload: this.pending.subarray(5, size + 5) })
      this.pending = this.pending.subarray(size + 5)
    }
    return frames
  }
}
