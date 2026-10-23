import { maxSessionFileBytes, maxSessionFiles, parseSessionFile, type SessionFile } from '../../shared/sessionFiles'

/** Attachment requests never expose the resume credential in a URL. */
export async function fileRequest(token: string, path: string, signal: AbortSignal, method = 'GET') {
  const request = () =>
    fetch('/api/terminal/files' + path, {
      method,
      signal,
      redirect: 'error',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, 'X-Outpost-Request': '1' },
    })
  let response = await request()
  for (let attempt = 0; method === 'GET' && response.status === 429 && attempt < 3; attempt++) {
    await response.body?.cancel()
    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
    signal.throwIfAborted()
    response = await request()
  }
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(error?.message || `File request failed (${response.status}).`)
  }
  return response
}

export async function listSessionFiles(token: string, signal: AbortSignal): Promise<SessionFile[]> {
  const value = await (await fileRequest(token, '', signal)).json()
  if (!Array.isArray(value) || value.length > maxSessionFiles) throw new Error('Invalid session file list.')
  return value.map(parseSessionFile)
}

export async function sessionFileBlob(
  token: string,
  file: Pick<SessionFile, 'id' | 'size' | 'mediaType'>,
  signal: AbortSignal,
) {
  const response = await fileRequest(token, '/' + file.id, signal)
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
