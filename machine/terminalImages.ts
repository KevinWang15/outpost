import { imageExtensions, maxImageBytes, type ImageMediaType } from '../shared/images'
import { terminalFileChunk, validImageWrite, type ImageWrite } from '../shared/terminalFiles'
import { saveImage } from './files'

/** One upload per viewer. The persistent terminal process shares a memory
 * budget across its viewers and drops partial uploads on silence or disconnect. */
let reserved = 0
export class TerminalImages {
  private upload?: { transfer: string; mime: string; bytes: Buffer; offset: number; timer: NodeJS.Timeout }

  constructor(private readonly session: string) {}

  close() {
    if (!this.upload) return
    clearTimeout(this.upload.timer)
    reserved -= this.upload.bytes.length
    this.upload = undefined
  }

  write(request: ImageWrite): string | undefined {
    if (!validImageWrite(request)) throw new Error('Invalid image chunk.')
    if (request.offset === 0) {
      this.close()
      if (reserved + request.size > 2 * maxImageBytes)
        throw new Error('Other viewers are uploading images. Try again shortly.')
      const bytes = Buffer.alloc(request.size)
      this.upload = {
        transfer: request.transfer,
        mime: request.mime,
        bytes,
        offset: 0,
        timer: setTimeout(() => this.close(), 30_000).unref(),
      }
      reserved += bytes.length
    }
    const upload = this.upload
    if (
      !upload ||
      upload.transfer !== request.transfer ||
      upload.offset !== request.offset ||
      upload.mime !== request.mime ||
      upload.bytes.length !== request.size
    )
      throw new Error('The image transfer changed. Paste again.')
    const expected = Math.min(terminalFileChunk, request.size - request.offset)
    const chunk = Buffer.from(request.chunk, 'base64')
    if (chunk.length !== expected) {
      this.close()
      throw new Error('Incomplete image chunk.')
    }
    chunk.copy(upload.bytes, upload.offset)
    upload.offset += chunk.length
    upload.timer.refresh()
    if (upload.offset === upload.bytes.length) {
      try {
        return saveImage(this.session, imageExtensions[upload.mime as ImageMediaType], upload.bytes).reference
      } finally {
        this.close()
      }
    }
  }
}
