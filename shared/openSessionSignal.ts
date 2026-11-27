// Private OSC 7770 sequence emitted by the machine CLI (`outpost new`, `outpost attach`)
// so an enclosing Outpost Desktop or Web terminal can automatically open the session.
// Standard terminals silently ignore unknown OSC numbers.
import { isHarnessId, type HarnessId } from './harnesses'
import { uuidRegexCaseInsensitive } from './schemas'
import { serverOrigin } from './serverOrigin'

export const OPEN_SESSION_OSC = 7770
export const OPEN_SESSION_PREFIX = 'outpost;open-session;'
export const MAX_OPEN_SESSION_OSC_BYTES = 4096

const desktopIdPattern = /^[A-Za-z0-9_-]{1,128}$/

interface OpenSessionRequest {
  v: 1
  sessionId: string
  name?: string
  tool?: HarnessId
  origin?: string
  targetId?: string
  hostname?: string
}

const cleanText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return undefined
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return undefined
  }
  return trimmed
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export function encodeOpenSessionOsc(
  request: Omit<OpenSessionRequest, 'v'>,
  env: Record<string, string | undefined> = {},
): string {
  const payload: OpenSessionRequest = {
    v: 1,
    sessionId: request.sessionId,
    ...(request.name ? { name: request.name.slice(0, 80) } : {}),
    ...(request.tool ? { tool: request.tool } : {}),
    ...(request.origin ? { origin: request.origin } : {}),
    ...(request.targetId ? { targetId: request.targetId } : {}),
    ...(request.hostname ? { hostname: request.hostname.slice(0, 128) } : {}),
  }
  const encoded = toBase64Url(JSON.stringify(payload))
  const osc = `\x1b]${OPEN_SESSION_OSC};${OPEN_SESSION_PREFIX}${encoded}\x07`
  if (env.TMUX) {
    // Wrap in tmux DCS passthrough (doubling ESC bytes inside).
    return `\x1bPtmux;${osc.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`
  }
  if (env.STY) {
    // Wrap in GNU Screen DCS passthrough.
    return `\x1bP${osc}\x1b\\`
  }
  return osc
}

export function parseOpenSessionOscData(data: string): OpenSessionRequest | null {
  if (data.length > MAX_OPEN_SESSION_OSC_BYTES || !data.startsWith(OPEN_SESSION_PREFIX)) return null
  const decoded = fromBase64Url(data.slice(OPEN_SESSION_PREFIX.length))
  if (!decoded) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const raw = parsed as Record<string, unknown>
  if (raw.v !== 1) return null
  if (typeof raw.sessionId !== 'string' || !uuidRegexCaseInsensitive.test(raw.sessionId)) return null

  let origin: string | undefined
  if (raw.origin !== undefined) {
    if (typeof raw.origin !== 'string') return null
    try {
      origin = serverOrigin(raw.origin)
    } catch {
      return null
    }
  }

  let targetId: string | undefined
  if (raw.targetId !== undefined) {
    if (typeof raw.targetId !== 'string' || !desktopIdPattern.test(raw.targetId)) return null
    targetId = raw.targetId
  }

  const tool = raw.tool !== undefined ? (isHarnessId(raw.tool) ? raw.tool : undefined) : undefined
  if (raw.tool !== undefined && !tool) return null

  const name = raw.name !== undefined ? cleanText(raw.name, 80) : undefined
  const hostname = raw.hostname !== undefined ? cleanText(raw.hostname, 128) : undefined

  return {
    v: 1,
    sessionId: raw.sessionId,
    ...(name ? { name } : {}),
    ...(tool ? { tool } : {}),
    ...(origin ? { origin } : {}),
    ...(targetId ? { targetId } : {}),
    ...(hostname ? { hostname } : {}),
  }
}
