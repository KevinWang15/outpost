import { sessionFileId } from '../shared/sessionFiles'
import { validFileRead } from '../shared/terminalFiles'
import { listFiles, readFileChunk, removeFile } from './files'
import { TerminalImages } from './terminalImages'

/** File and clipboard requests have the same limits on every terminal attachment. */
export class TerminalFileRequests {
  private images: TerminalImages
  private reads = 0
  constructor(
    private session: string,
    private send: (message: object) => void,
    private changed: () => void,
  ) {
    this.images = new TerminalImages(session)
  }

  close() {
    this.images.close()
  }

  handle(message: Record<string, unknown>) {
    const { type, id } = message
    const ok = (data?: object) => this.send({ type: 'result', id, ok: true, ...data })
    const fail = (message: string) => this.send({ type: 'result', id, ok: false, message })
    switch (type) {
      case 'image-write':
        try {
          ok({ reference: this.images.write(message) })
        } catch (error) {
          fail((error as Error).message)
        }
        break
      case 'file-list':
        ok({ files: listFiles(this.session) })
        break
      case 'file-remove':
        if (!sessionFileId(message.file)) throw new Error('Invalid session file ID.')
        void removeFile(this.session, message.file).then(
          () => {
            this.changed()
            ok()
          },
          () => fail('Could not remove the session file.'),
        )
        break
      case 'file-read':
        if (!validFileRead(message) || typeof id !== 'string' || id.length > 80)
          throw new Error('Invalid session file request')
        if (this.reads >= 4) {
          fail('Too many concurrent file reads.')
          break
        }
        this.reads++
        void readFileChunk(this.session, message.file, message.offset)
          .then(
            chunk => ok({ chunk: chunk.toString('base64') }),
            () => fail('Could not read the session file.'),
          )
          .finally(() => this.reads--)
        break
      default:
        return false
    }
    return true
  }
}
