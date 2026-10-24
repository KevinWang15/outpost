/** Published files are immutable snapshots, owned by one managed session. */
export const maxSessionFileBytes = 32 * 1024 * 1024
export const maxSessionFiles = 100
export interface SessionFile {
  id: string
  name: string
  createdAt: string
  size: number
  mediaType: string
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
export const previewImage = (file: SessionFile) =>
  ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mediaType)

export function parseSessionFile(value: unknown): SessionFile {
  const file = value as SessionFile | null
  if (
    !file ||
    !sessionFileId(file.id) ||
    typeof file.name !== 'string' ||
    !file.name ||
    file.name === '.' ||
    file.name === '..' ||
    file.name.length > 240 ||
    [...file.name].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === '/' || c === '\\') ||
    typeof file.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(file.createdAt)) ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > maxSessionFileBytes ||
    !['application/octet-stream', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mediaType)
  )
    throw new Error('Invalid session file metadata.')
  return { id: file.id, name: file.name, createdAt: file.createdAt, size: file.size, mediaType: file.mediaType }
}
