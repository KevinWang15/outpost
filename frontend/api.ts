export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message) }
}
function unauthorized(path: string, status: number) {
  if (status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('outpost:unauthorized'))
}
export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    cache: 'no-store', signal, credentials: 'same-origin',
    method, headers: { 'x-outpost-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }))
    unauthorized(path, response.status)
    throw new ApiError(error.message, response.status, error.code)
  }
  return response.status === 204 ? undefined as T : response.json()
}

export async function streamInstallation(targetId: string, jobId: string, onEvent: (event: import('../shared/session-manager').InstallationEvent) => void, signal: AbortSignal) {
  const response = await fetch(`/api/targets/${targetId}/installations/${jobId}/events`, { cache: 'no-store', signal, headers: { 'x-outpost-request': '1' } })
  if (!response.ok) {
    unauthorized('/targets', response.status)
    throw new ApiError((await response.json()).message, response.status)
  }
  if (!response.body) throw new Error('Installation output stream is unavailable')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let pending = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      let end
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (line) onEvent(JSON.parse(line))
      }
      if (pending.length > 1024 * 1024) throw new Error('Invalid installation log stream')
      if (done) { if (pending.trim()) throw new Error('Incomplete installation log stream'); break }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
