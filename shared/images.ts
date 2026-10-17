/** Image attachments use binary bytes; only their saved reference enters the PTY. */
export const imageMediaTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ImageMediaType = (typeof imageMediaTypes)[number]
export const imageExtensions: Record<ImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}
export const maxImageBytes = 16 * 1024 * 1024
export interface UploadedImage {
  path: string
  reference: string
}

export function imageProblem(file: { type: string; size: number }): string | null {
  if (!(imageMediaTypes as readonly string[]).includes(file.type)) return 'That is not a PNG, JPEG, GIF, or WebP image.'
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > maxImageBytes)
    return 'Images must be between 1 byte and 16 MB.'
  return null
}
