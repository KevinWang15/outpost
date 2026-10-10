import type { SessionImage } from '../shared/session-manager'
import { imageFileError } from './image-upload'

export type TerminalImagePasteState = { busy: boolean; message: string; canRetry: boolean } | null

/** One local paste gesture owns one upload. Retain its result for explicit retry,
 * and never insert a delayed reference into a different terminal connection. */
export class TerminalImagePaste {
  private file: File | null = null
  private uploaded: SessionImage | null = null
  private pending: AbortController | null = null
  private disposed = false

  constructor(private options: {
    connection: () => WebSocket | null
    blocked: () => boolean
    upload: (file: File, signal: AbortSignal) => Promise<SessionImage>
    insert: (connection: WebSocket, reference: string) => Promise<void>
    onChange: (state: TerminalImagePasteState) => void
  }) {}

  get busy() { return this.pending !== null }

  paste(file: File) {
    if (this.disposed || this.pending) return
    this.file = null; this.uploaded = null
    const failure = imageFileError(file)
    if (failure) { this.options.onChange({ busy: false, message: failure, canRetry: false }); return }
    this.file = file
    void this.retry()
  }

  async retry() {
    if (this.disposed || this.pending || !this.file) return
    const connection = this.options.connection()
    if (!connection || this.options.blocked()) {
      this.options.onChange({ busy: false, message: connection ? 'Wait for Send to finish, then retry the image paste.' : 'Reconnect to paste this image.', canRetry: true })
      return
    }
    const controller = new AbortController(); this.pending = controller
    this.options.onChange({ busy: true, message: this.uploaded ? 'Pasting image reference…' : 'Uploading image…', canRetry: false })
    let state: TerminalImagePasteState = null
    try {
      const uploaded = this.uploaded ?? await this.options.upload(this.file, controller.signal)
      if (this.disposed) return
      this.uploaded = uploaded
      // The existing tmux upload channel already inserts the path once.
      if (!this.uploaded.injected) {
        if (connection !== this.options.connection()) throw new Error('Image uploaded. Reconnect and retry to paste its reference.')
        await this.options.insert(connection, this.uploaded.reference)
      }
      if (!this.disposed) { this.file = null; this.uploaded = null }
    } catch (error) {
      const message = (error as Error).message
      state = { busy: false, message: this.uploaded ? message : `${message} Check the terminal before retrying.`, canRetry: true }
    } finally {
      this.pending = null
      if (!this.disposed) this.options.onChange(state)
    }
  }

  dismiss() {
    if (this.pending) return
    this.file = null; this.uploaded = null; this.options.onChange(null)
  }

  dispose() {
    this.disposed = true; this.pending?.abort(); this.file = null; this.uploaded = null
  }
}
