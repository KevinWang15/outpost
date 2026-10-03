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
  return parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}
