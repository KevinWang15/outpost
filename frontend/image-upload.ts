import type { SessionImage, SessionImageInput } from '../shared/session-manager'
import { imageMediaTypes, maxImageBytes } from '../shared/session-manager'
import { api } from './api'

const mediaTypes = new Set<string>(imageMediaTypes)

export function imageFileError(file: File): string | null {
  if (!mediaTypes.has(file.type)) return 'That is not a PNG, JPEG, GIF, or WebP image.'
  if (!file.size || file.size > maxImageBytes) return 'Images are limited to 16 MB.'
  return null
}

export async function uploadSessionImage(targetId: string, sessionId: string, file: File, signal?: AbortSignal): Promise<SessionImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Could not read the image file'))
    reader.readAsDataURL(file)
  })
  return api<SessionImage>(`/targets/${targetId}/sessions/${sessionId}/image`, 'POST', {
    data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    mediaType: file.type as SessionImageInput['mediaType'],
  }, signal)
}
