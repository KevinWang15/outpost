import type { SessionImage, SessionImageInput } from '../shared/session-manager'
import type { NativeClipboard } from './native-clipboard'

/** The terminal owns the paste, rather than the manager or the remote process.
 * Uploads survive explicit retries but are never replayed on reconnect. */
export class NativePaste<Connection> {
  private clipboard: NativeClipboard | null = null
  private uploaded: SessionImage | null = null
  private pending: AbortController | null = null
  private disposed = false

  constructor(private options: {
    connection: () => Connection | null
    read: (signal: AbortSignal) => Promise<NativeClipboard>
    upload: (image: SessionImageInput, signal: AbortSignal) => Promise<SessionImage>
    insert: (connection: Connection, text: string) => void
    status: (message: string) => void
  }) {}

  async paste(retry = false) {
    if (this.disposed || this.pending) return
    const connection = this.options.connection()
    if (!connection) { this.options.status('Reconnect before pasting.'); return }
    if (retry && !this.clipboard) { this.options.status('There is no failed paste to retry.'); return }
    const controller = new AbortController(); this.pending = controller
    try {
      if (!retry) {
        const clipboard = await this.options.read(controller.signal)
        if (this.disposed) return
        this.clipboard = clipboard; this.uploaded = null
      }
      if (connection !== this.options.connection()) throw new Error('The terminal connection changed before pasting.')
      if (this.clipboard?.kind === 'empty') { this.clipboard = null; this.options.status('The local clipboard has no image or text.'); return }
      if (this.clipboard?.kind === 'image') {
        if (!this.uploaded) {
          this.options.status('Uploading clipboard image…')
          this.uploaded = await this.options.upload(this.clipboard.image, controller.signal)
        }
        if (this.disposed) return
        if (!this.uploaded.injected) this.insert(connection, this.uploaded.reference)
        this.options.status('Image pasted.')
      } else if (this.clipboard?.kind === 'text') this.insert(connection, this.clipboard.text)
      this.clipboard = null; this.uploaded = null
    } catch (error) {
      if (!this.disposed) this.options.status(`${(error as Error).message}${this.clipboard ? ' Paste kept. Check the terminal; Shift+F8 retries it, and F8 pastes the current clipboard.' : ''}`)
    } finally { this.pending = null }
  }

  private insert(connection: Connection, text: string) {
    if (connection !== this.options.connection()) throw new Error('The terminal connection changed before insertion.')
    this.options.insert(connection, text)
  }

  dispose() { this.disposed = true; this.pending?.abort(); this.clipboard = null; this.uploaded = null }
}
