/** Session files are immutable snapshots, owned by one managed session: files
 * its agent published, and files sent to it in a message. */
export const maxSessionFileBytes = 32 * 1024 * 1024
export const maxSessionFiles = 100
export const sessionFileSources = ['published', 'received'] as const
export interface SessionFile {
  id: string
  name: string
  createdAt: string
  size: number
  mediaType: string
  source: (typeof sessionFileSources)[number]
}

/** Narrow native file capability, bound to one terminal session by the host. */
export interface SessionFileBridge {
  list(): Promise<SessionFile[]>
  read(file: SessionFile): Promise<ArrayBuffer>
  remove(id: string): Promise<void>
  download(file: SessionFile): Promise<boolean>
}
export interface FileViewerBridge extends SessionFileBridge {
  selection(): Promise<string>
  close(): void
}
export const sessionFileId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)
/** The stored media type, by signature as on targets (outpost_files.media_type):
 * only passive raster formats are previewed; everything else is bytes. */
export function sniffMediaType(prefix: Uint8Array) {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => prefix[index] === byte)
  const ascii = (from: number, text: string) => [...text].every((c, i) => prefix[from + i] === c.charCodeAt(0))
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  return 'application/octet-stream'
}
export const previewImage = (file: SessionFile) =>
  ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mediaType)

/** A filename the target store accepts: no directories or control characters. */
export const sessionFileName = (name: unknown): name is string =>
  typeof name === 'string' &&
  name !== '' &&
  name !== '.' &&
  name !== '..' &&
  new TextEncoder().encode(name).length <= 240 &&
  ![...name].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === '/' || c === '\\')

export function parseSessionFile(value: unknown): SessionFile {
  const file = value as SessionFile | null
  if (
    !file ||
    !sessionFileId(file.id) ||
    !sessionFileName(file.name) ||
    typeof file.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(file.createdAt)) ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > maxSessionFileBytes ||
    !['application/octet-stream', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mediaType) ||
    !sessionFileSources.includes(file.source)
  )
    throw new Error('Invalid session file metadata.')
  return {
    id: file.id,
    name: file.name,
    createdAt: file.createdAt,
    size: file.size,
    mediaType: file.mediaType,
    source: file.source,
  }
}
