export interface SignalMessage { version: 1; id: string; type: string; payload: unknown }
export interface SessionSignal extends SignalMessage { targetId: string; sessionId: string }
export interface SignalEnvironment {
  BROWSER: string
  OUTPOST_SIGNAL_BIN: string
  OUTPOST_SIGNAL_CONFIG: string
  OUTPOST_SIGNAL_ENV: string
  OUTPOST_SIGNAL_URL: string
  OUTPOST_SESSION_TOKEN: string
}
export const signalTypePattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/
export const signalIdentity = (event: SessionSignal) => JSON.stringify([event.targetId, event.sessionId, event.id])
export function browserUrl(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || !('url' in payload) || typeof payload.url !== 'string' || payload.url.length > 8192 || [...payload.url].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) throw new Error('Expected a browser URL.')
  const url = new URL(payload.url)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Browser links must use HTTP or HTTPS without credentials.')
  return url.href
}
