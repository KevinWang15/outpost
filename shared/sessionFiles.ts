import Type, { type Static } from 'typebox'
import { Value } from 'typebox/value'

/** Session files are immutable snapshots, owned by one managed session: files
 * its agent published, and files sent to it in a message. */
export const maxSessionFileBytes = 32 * 1024 * 1024
export const maxSessionFiles = 100
export const sessionFileSources = ['published', 'received'] as const
const fileIdPattern = /^[a-f0-9]{32}$/
export const sessionFileSchema = Type.Object(
  {
    id: Type.String({ pattern: fileIdPattern.source }),
    name: Type.String({ minLength: 1, maxLength: 240, pattern: '^(?!\\.{1,2}$)[^\\u0000-\\u001f\\u007f/\\\\]+$' }),
    createdAt: Type.String(),
    size: Type.Integer({ minimum: 0, maximum: maxSessionFileBytes }),
    mediaType: Type.Enum(['application/octet-stream', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    source: Type.Enum(sessionFileSources),
  },
  { additionalProperties: false },
)
export type SessionFile = Static<typeof sessionFileSchema>

export const sessionFileId = (id: unknown): id is string => typeof id === 'string' && fileIdPattern.test(id)
/** The stored media type, by signature:
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
  if (
    !Value.Check(sessionFileSchema, value) ||
    !sessionFileName(value.name) ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    throw new Error('Invalid session file metadata.')
  return value
}
