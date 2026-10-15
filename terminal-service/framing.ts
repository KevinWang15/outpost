export const maxFrame = 32 * 1024 * 1024

export function frame(kind: string, value: Buffer | object) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))
  if (data.length > maxFrame) throw new Error('Terminal frame exceeds its limit')
  const header = Buffer.alloc(5)
  header.write(kind, 0, 'ascii')
  header.writeUInt32BE(data.length, 1)
  return Buffer.concat([header, data])
}

export class Decoder {
  private pending: Buffer = Buffer.alloc(0)
  feed(data: Buffer): { kind: string; data: Buffer }[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, data]) : data
    const result = []
    while (this.pending.length >= 5) {
      const size = this.pending.readUInt32BE(1)
      if (size > maxFrame) throw new Error('Terminal frame exceeds its limit')
      if (this.pending.length < size + 5) break
      result.push({ kind: this.pending.toString('ascii', 0, 1), data: this.pending.subarray(5, size + 5) })
      this.pending = this.pending.subarray(size + 5)
    }
    return result
  }
}
