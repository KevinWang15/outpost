export function loopbackHost(value: string | undefined, setting = 'HOST'): string {
  const host = value ?? '127.0.0.1'
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error(`${setting} must be 127.0.0.1, ::1, or localhost. Outpost only supports loopback access.`)
  }
  return host === 'localhost' ? '127.0.0.1' : host
}

export function isLoopbackAddress(address: string): boolean {
  if (address === '::1') return true
  const ipv4 = address.replace(/^::ffff:/, '')
  const parts = ipv4.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

export function isLoopbackName(hostname: string): boolean {
  return hostname === 'localhost' || isLoopbackAddress(hostname.replace(/^\[|\]$/g, ''))
}

/** Parse an HTTP Host header strictly: reject credentials, paths, queries, or fragments. */
export function parseHostHeader(host: string | undefined, protocol = 'http:'): URL | null {
  if (!host) return null
  try {
    const url = new URL(`${protocol}//${host}`)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url
  } catch {
    return null
  }
}

/** Parse an HTTP Origin header strictly: reject credentials, paths, queries, or fragments. */
export function parseOriginHeader(origin: string | undefined): URL | null {
  if (!origin) return null
  try {
    const url = new URL(origin)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url
  } catch {
    return null
  }
}
