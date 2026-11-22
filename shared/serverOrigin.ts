/** Public Outpost endpoints require HTTPS. A loopback instance can use HTTP. */
export function serverOrigin(value: string): string {
  if (value.length > 2048 || /[\s\\]/.test(value)) throw new Error('Enter an Outpost server URL.')
  const url = new URL(value)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Use an HTTPS server address, or HTTP on localhost, without a path or credentials.')
  return url.origin
}
