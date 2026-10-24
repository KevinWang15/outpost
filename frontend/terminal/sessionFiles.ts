import { SessionFileCache } from '../../shared/sessionFileCache'
import { fileRequest, listSessionFiles, sessionFileBlob } from '../../shared/sessionFileRequests'
import type { SessionFile, SessionFileBridge } from '../../shared/sessionFiles'

export { fileSize } from '../../shared/sessionFileRequests'

/** One owner for browser bytes, thumbnail decoding and native file capabilities.
 * Native originals live in the main process so a window-wide viewer and Save
 * dialog share the same cache as the terminal's thumbnail list. */
export class SessionFiles {
  private originals: SessionFileCache | null
  readonly thumbnails: SessionFileCache
  constructor(
    token: string,
    readonly native?: SessionFileBridge,
  ) {
    const auth = { origin: '', token }
    this.originals = native ? null : new SessionFileCache((file, signal) => sessionFileBlob(auth, file, signal))
    this.list = signal => (native ? native.list() : listSessionFiles(auth, signal))
    this.remove = async (id, signal) => {
      if (native) await native.remove(id)
      else await fileRequest(auth, '/' + id, signal, 'DELETE')
      this.originals?.remove(id)
      this.thumbnails.remove(id)
    }
    this.thumbnails = new SessionFileCache(
      async (file, signal) => {
        const blob = await this.read(file)
        signal.throwIfAborted()
        const bitmap = await createImageBitmap(blob)
        try {
          const scale = Math.min(1, 88 / Math.max(bitmap.width, bitmap.height))
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(bitmap.width * scale))
          canvas.height = Math.max(1, Math.round(bitmap.height * scale))
          const context = canvas.getContext('2d')
          if (!context) throw new Error('Image preview is unavailable.')
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
          return await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
              value => (value ? resolve(value) : reject(new Error('Could not create a thumbnail.'))),
              'image/png',
            ),
          )
        } finally {
          bitmap.close()
        }
      },
      4 * 1024 * 1024,
    )
  }
  list: (signal: AbortSignal) => Promise<SessionFile[]>
  remove: (id: string, signal: AbortSignal) => Promise<void>
  async read(file: SessionFile) {
    return this.originals
      ? this.originals.read(file)
      : new Blob([await this.native!.read(file)], { type: file.mediaType })
  }
  async download(file: SessionFile) {
    if (this.native) return this.native.download(file)
    const blob = await this.read(file)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = file.name
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
    return true
  }
  retain(files: SessionFile[]) {
    this.originals?.retain(files)
    this.thumbnails.retain(files)
  }
  clear() {
    this.originals?.clear()
    this.thumbnails.clear()
  }
}
