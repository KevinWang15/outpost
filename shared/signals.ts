// Signal types a remote session may send to the attached client. Each has a
// validator here and a handler in both clients (web terminal, connector).
export function browserUrl(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1
    || !('url' in payload) || typeof payload.url !== 'string' || payload.url.length > 8192
    || [...payload.url].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) {
    throw new Error('Expected a browser URL.')
  }
  const url = new URL(payload.url)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Browser links must use HTTP or HTTPS without credentials.')
  return url.href
}

export const signalValidators: Record<string, (payload: unknown) => unknown> = {
  'browser.open': payload => ({ url: browserUrl(payload) }),
}
