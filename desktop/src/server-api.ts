/** Native HTTP requests never follow redirects or share browser cookies. */
export class ServerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}
export async function serverRequest(
  origin: string,
  path: string,
  options: { token?: string; body?: unknown; signal?: AbortSignal; method?: string } = {},
): Promise<unknown> {
  const timeout = AbortSignal.timeout(30_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const response = await fetch(`${origin}/api/desktop${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    redirect: 'error',
    credentials: 'omit',
    signal,
    headers: {
      'x-outpost-request': '1',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  if (response.status === 204) return undefined
  const reader = response.body?.getReader()
  if (!reader) throw new Error('The server returned an empty response.')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4 * 1024 * 1024) throw new Error('The server response is too large.')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  let data: unknown
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ServerApiError(
      'This server did not return a valid Outpost response. Check its address and version.',
      response.status,
    )
  }
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
        ? data.message.slice(0, 1024)
        : `Server returned ${response.status}.`
    throw new ServerApiError(message, response.status)
  }
  return data
}

/** One queue per catalogue load, shared by target and session requests. */
export function requestQueue(limit: number, signal?: AbortSignal) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Request queue limit must be positive.')
  let active = 0
  let stopped = false
  const waiting: {
    work: () => Promise<unknown>
    resolve: (value: unknown) => void
    reject: (error: unknown) => void
  }[] = []
  const stop = () => {
    stopped = true
    const error = signal?.reason ?? new Error('The request queue was cancelled.')
    while (waiting.length) waiting.shift()!.reject(error)
  }
  signal?.addEventListener('abort', stop, { once: true })
  const pump = () => {
    while (!stopped && active < limit && waiting.length) {
      const item = waiting.shift()!
      active++
      void Promise.resolve()
        .then(() => {
          signal?.throwIfAborted()
          return item.work()
        })
        .then(item.resolve, item.reject)
        .finally(() => {
          active--
          pump()
        })
    }
  }
  return <T>(work: () => Promise<T>): Promise<T> => {
    if (stopped || signal?.aborted)
      return Promise.reject(signal?.reason ?? new Error('The request queue was cancelled.'))
    return new Promise<T>((resolve, reject) => {
      waiting.push({ work, resolve: value => resolve(value as T), reject })
      pump()
    })
  }
}
