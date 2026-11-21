import type { TerminalSocket } from './socket'
import { SessionFileCache } from '../../shared/sessionFileCache'
import type { SessionFile } from '../../shared/sessionFiles'

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

export class SessionFiles {
  private originals: SessionFileCache
  readonly thumbnails: SessionFileCache
  constructor(source: Pick<TerminalSocket, 'readFile' | 'listFiles' | 'removeFile'>) {
    this.originals = new SessionFileCache(source.readFile)
    this.list = source.listFiles
    this.remove = async (id, signal) => {
      await source.removeFile(id, signal)
      this.originals.remove(id)
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
    return this.originals.read(file)
  }
  async download(file: SessionFile) {
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
    this.originals.retain(files)
    this.thumbnails.retain(files)
  }
  clear() {
    this.originals.clear()
    this.thumbnails.clear()
  }
}
