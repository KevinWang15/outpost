import { sessionFileId } from '../shared/sessionFiles'
import { validFileRead, validImagePaste, type ImagePaste, type ImagePasteMode } from '../shared/terminalFiles'
import { listFiles, readFileChunk, removeFile } from './files'
import { TerminalImages, type TerminalImage } from './terminalImages'

export interface TerminalClipboard {
  paste(image: TerminalImage, signal: AbortSignal, sendKey: () => void): Promise<boolean>
}

/** Prefer the tool's dedicated clipboard paste when available; fall back to a file path otherwise. */
export async function pasteTerminalImage(
  image: TerminalImage,
  mode: ImagePasteMode,
  signal: AbortSignal,
  options: {
    exited: () => boolean
    held: () => boolean
    clipboard: TerminalClipboard | null
    sendKey: () => void
    pastePath: (image: TerminalImage) => void
  },
): Promise<ImagePasteMode> {
  if (options.exited()) throw new Error('The coding tool exited.')
  const fallbackToPath = (): ImagePasteMode => {
    signal.throwIfAborted()
    if (options.exited()) throw new Error('The coding tool exited.')
    options.pastePath(image)
    return 'path'
  }
  if (mode === 'path' || !options.clipboard) return fallbackToPath()
  const delivered = await options.clipboard.paste(image, signal, () => {
    if (options.exited()) throw new Error('The coding tool exited.')
    if (options.held()) throw new Error('The agent is receiving a message. Paste again in a moment.')
    options.sendKey()
  })
  return delivered ? 'attachment' : fallbackToPath()
}

/** File and clipboard requests have the same limits on every terminal attachment. */
export class TerminalFileRequests {
  private images = new TerminalImages()
  private lifetime = new AbortController()
  private reads = 0
  constructor(
    private session: string,
    private send: (message: object) => void,
    private changed: () => void,
    private paste: (
      image: TerminalImage,
      mode: ImagePasteMode,
      signal: AbortSignal,
    ) => ImagePasteMode | void | Promise<ImagePasteMode | void>,
  ) {}

  close() {
    this.lifetime.abort()
    this.images.close()
  }

  handle(message: Record<string, unknown>) {
    const { type, id } = message
    const ok = (data?: object) => this.send({ type: 'result', id, ok: true, ...data })
    const fail = (message: string) => this.send({ type: 'result', id, ok: false, message })
    switch (type) {
      case 'image-write':
        try {
          this.images.write(message)
          ok()
        } catch (error) {
          fail((error as Error).message)
        }
        break
      case 'image-paste': {
        const request = message as unknown as ImagePaste
        if (!validImagePaste(request)) {
          fail('Invalid image paste.')
          break
        }
        void this.images
          .paste(request.transfer, image => this.paste(image, request.mode, this.lifetime.signal))
          .then(
            mode => ok({ mode: mode ?? request.mode }),
            error => fail((error as Error).message),
          )
        break
      }
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
