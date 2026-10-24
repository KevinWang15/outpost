import { maxSessionFileBytes, maxSessionFiles, parseSessionFile, type SessionFile } from './sessionFiles'

export interface SessionFileAuthorization {
  origin: string
  token: string
}

/** Attachment requests never expose the resume credential in a URL. */
export async function fileRequest(auth: SessionFileAuthorization, path: string, signal: AbortSignal, method = 'GET') {
  const request = () =>
    fetch(auth.origin + '/api/terminal/files' + path, {
      method,
      signal,
      redirect: 'error',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${auth.token}`, 'X-Outpost-Request': '1' },
    })
  let response = await request()
  for (let attempt = 0; method === 'GET' && response.status === 429 && attempt < 3; attempt++) {
    await response.body?.cancel()
    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
    signal.throwIfAborted()
    response = await request()
  }
  if (!response.ok) {
    const error: unknown = await response.json().catch(() => null)
    throw new Error(
      error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message
        : `File request failed (${response.status}).`,
    )
  }
  return response
}

export async function listSessionFiles(auth: SessionFileAuthorization, signal: AbortSignal): Promise<SessionFile[]> {
  const value = await (await fileRequest(auth, '', signal)).json()
  if (!Array.isArray(value) || value.length > maxSessionFiles) throw new Error('Invalid session file list.')
  return value.map(parseSessionFile)
}

export async function sessionFileBlob(
  auth: SessionFileAuthorization,
  file: Pick<SessionFile, 'id' | 'size' | 'mediaType'>,
  signal: AbortSignal,
) {
  const response = await fileRequest(auth, '/' + file.id, signal)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('File response is empty.')
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > file.size || size > maxSessionFileBytes) throw new Error('File exceeds its declared size.')
      chunks.push(value)
    }
    if (size !== file.size) throw new Error('File transfer was incomplete. Try again.')
    return new Blob(chunks, { type: file.mediaType })
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
