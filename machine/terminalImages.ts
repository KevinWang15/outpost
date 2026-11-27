import { imageProblem, maxImageBytes, type ImageMediaType } from '../shared/images'
import { terminalFileChunk, validImageWrite } from '../shared/terminalFiles'
import { sniffMediaType } from '../shared/sessionFiles'

export type TerminalImage = { mime: ImageMediaType; bytes: Buffer }

/** One upload per viewer. The persistent terminal process shares a memory
 * budget across its viewers and drops partial uploads on silence or disconnect. */
let reserved = 0
export class TerminalImages {
  private upload?: { transfer: string; mime: string; bytes: Buffer; offset: number; timer: NodeJS.Timeout }

  private pasting = false

  close() {
    if (!this.upload) return
    clearTimeout(this.upload.timer)
    reserved -= this.upload.bytes.length
    this.upload = undefined
  }

  write(request: unknown) {
    if (!validImageWrite(request)) throw new Error('Invalid image chunk.')
    const expected = Math.min(terminalFileChunk, request.size - request.offset)
    const chunk = Buffer.from(request.chunk, 'base64')
    if (chunk.length !== expected) {
      this.close()
      throw new Error('Incomplete image chunk.')
    }
    this.writeBytes(request.transfer, request.mime, request.size, request.offset, chunk)
  }

  /** Append verified raw chunk bytes for any transport (WebSocket or in-band SSH bridge). */
  writeBytes(transfer: string, mime: string, size: number, offset: number, chunk: Buffer) {
    if (this.pasting) throw new Error('Wait for the current image paste.')
    const problem = imageProblem({ type: mime, size })
    if (problem) throw new Error(problem)
    if (!Number.isSafeInteger(offset) || offset < 0 || chunk.length === 0 || offset + chunk.length > size) {
      this.close()
      throw new Error('Incomplete image chunk.')
    }
    if (offset === 0) {
      this.close()
      if (reserved + size > 2 * maxImageBytes) throw new Error('Other viewers are uploading images. Try again shortly.')
      const bytes = Buffer.alloc(size)
      this.upload = {
        transfer,
        mime,
        bytes,
        offset: 0,
        timer: setTimeout(() => this.close(), 30_000).unref(),
      }
      reserved += bytes.length
    }
    const upload = this.upload
    if (
      !upload ||
      upload.transfer !== transfer ||
      upload.offset !== offset ||
      upload.mime !== mime ||
      upload.bytes.length !== size
    )
      throw new Error('The image transfer changed. Paste again.')
    chunk.copy(upload.bytes, upload.offset)
    upload.offset += chunk.length
    upload.timer.refresh()
  }

  async paste<T>(transfer: unknown, consume: (image: TerminalImage) => T | Promise<T>): Promise<T> {
    const upload = this.upload
    if (this.pasting || !upload || upload.transfer !== transfer || upload.offset !== upload.bytes.length)
      throw new Error('This image is incomplete or expired. Paste it again.')
    this.pasting = true
    // Keep its memory reserved until the driver releases the bytes, even if the viewer disconnects.
    this.upload = undefined
    clearTimeout(upload.timer)
    try {
      const mime = sniffMediaType(upload.bytes)
      if (mime === 'application/octet-stream' || mime !== upload.mime)
        throw new Error('The image contents do not match its format.')
      return await consume({ mime, bytes: upload.bytes })
    } finally {
      this.pasting = false
      reserved -= upload.bytes.length
    }
  }
}
