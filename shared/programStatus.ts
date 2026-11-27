// OSC 7501: Program Status Protocol.
// Follows Ghostty's canonical parser and limits:
//   query:  ESC ] 7501 ; ? ST
//   reply:  ESC ] 7501 ; ?:states=idle,working,done,blocked,error:kinds=permission,question,auth ST
//   report: ESC ] 7501 ; state=working:app=claude-code:progress=40 ST

const programStatusStates = ['idle', 'working', 'done', 'blocked', 'error', 'clear'] as const
export type ProgramStatusState = (typeof programStatusStates)[number]

export const blockedKinds = ['permission', 'question', 'auth'] as const
export type BlockedKind = (typeof blockedKinds)[number]

/** Every limit counts UTF-8 bytes; any violation discards the whole report. */
export const programStatusLimits = {
  maxSequenceBytes: 4096,
  maxBodyBytes: 4096 - '\x1b]7501;'.length - '\x1b\\'.length,
  maxKeyBytes: 16,
  maxMsgEncodedBytes: 2732,
  maxMsgBytes: 2048,
  maxTitleEncodedBytes: 256,
  maxTitleBytes: 192,
  maxAppBytes: 32,
  maxIdBytes: 128,
  maxIdSegmentBytes: 32,
  maxIdDepth: 8,
} as const

export const programStatusQueryReply = `?:states=${programStatusStates.filter(state => state !== 'clear').join(',')}:kinds=${blockedKinds.join(',')}`

type OscTerminator = 'st' | 'bel'

export interface ProgramStatusReport {
  state: ProgramStatusState
  id: string | null
  app: string | null
  kind: BlockedKind | null
  progress: number | null
  title: string | null
  msg: string | null
}

type ProgramStatusCommand =
  { kind: 'query'; terminator: OscTerminator } | { kind: 'report'; report: ProgramStatusReport }

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

const utf8Bytes = (text: string) => encoder.encode(text).byteLength

const namePattern = /^[A-Za-z0-9_.+-]+$/
const valuePattern = /^[A-Za-z0-9_.+,/=-]*$/
const asciiWhitespace = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g

const trimAscii = (text: string) => text.replace(asciiWhitespace, '')

const isName = (value: string) => value.length > 0 && namePattern.test(value)

function validId(value: string): boolean {
  if (utf8Bytes(value) > programStatusLimits.maxIdBytes) return false
  const segments = value.split('/')
  if (segments.length > programStatusLimits.maxIdDepth) return false
  for (const segment of segments) {
    if (utf8Bytes(segment) > programStatusLimits.maxIdSegmentBytes) return false
    if (!isName(segment)) return false
  }
  return true
}

function parseProgress(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null
  let result = 0
  for (let i = 0; i < value.length; i++) {
    result = result * 10 + (value.charCodeAt(i) - 48)
    if (result > 100) return null
  }
  return result
}

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const base64Table = new Int16Array(128).fill(-1)
for (let i = 0; i < base64Alphabet.length; i++) base64Table[base64Alphabet.charCodeAt(i)] = i

function isSafeUtf8(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false
  }
  return true
}

/** Strict RFC 4648 standard base64 with optional padding, canonical trailing bits,
 * and safe UTF-8 validation (no C0, DEL, or C1 control characters). */
function decodeBase64Text(encoded: string, maxBytes: number): string | null {
  if (encoded.length === 0) return ''
  let body = encoded
  if (encoded.endsWith('=')) {
    if (encoded.length % 4 !== 0) return null
    const padding = encoded.endsWith('==') ? 2 : 1
    body = encoded.slice(0, encoded.length - padding)
    if (body.length === 0 || body.includes('=')) return null
  } else if (encoded.length % 4 === 1) {
    return null
  }

  const remainder = body.length % 4
  const fullQuads = (body.length - remainder) / 4
  const byteLength = fullQuads * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0)
  if (byteLength > maxBytes) return null

  const out = new Uint8Array(byteLength)
  let outPos = 0
  for (let i = 0; i < fullQuads * 4; i += 4) {
    const a = body.charCodeAt(i)
    const b = body.charCodeAt(i + 1)
    const c = body.charCodeAt(i + 2)
    const d = body.charCodeAt(i + 3)
    if ((a | b | c | d) >= 128) return null
    const v0 = base64Table[a]
    const v1 = base64Table[b]
    const v2 = base64Table[c]
    const v3 = base64Table[d]
    if ((v0 | v1 | v2 | v3) < 0) return null
    const triple = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3
    out[outPos++] = (triple >>> 16) & 0xff
    out[outPos++] = (triple >>> 8) & 0xff
    out[outPos++] = triple & 0xff
  }

  const tail = fullQuads * 4
  if (remainder === 2) {
    const a = body.charCodeAt(tail)
    const b = body.charCodeAt(tail + 1)
    if ((a | b) >= 128) return null
    const v0 = base64Table[a]
    const v1 = base64Table[b]
    if ((v0 | v1) < 0 || (v1 & 0x0f) !== 0) return null
    out[outPos] = ((v0 << 2) | (v1 >>> 4)) & 0xff
  } else if (remainder === 3) {
    const a = body.charCodeAt(tail)
    const b = body.charCodeAt(tail + 1)
    const c = body.charCodeAt(tail + 2)
    if ((a | b | c) >= 128) return null
    const v0 = base64Table[a]
    const v1 = base64Table[b]
    const v2 = base64Table[c]
    if ((v0 | v1 | v2) < 0 || (v2 & 0x03) !== 0) return null
    out[outPos] = ((v0 << 2) | (v1 >>> 4)) & 0xff
    out[outPos + 1] = (((v1 & 0x0f) << 4) | (v2 >>> 2)) & 0xff
  }

  let decoded: string
  try {
    decoded = decoder.decode(out)
  } catch {
    return null
  }
  return isSafeUtf8(decoded) ? decoded : null
}

function encodeBase64Utf8(text: string): string {
  const bytes = encoder.encode(text)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const has1 = i + 1 < bytes.length
    const has2 = i + 2 < bytes.length
    const b1 = has1 ? bytes[i + 1] : 0
    const b2 = has2 ? bytes[i + 2] : 0
    const triple = (b0 << 16) | (b1 << 8) | b2
    out += base64Alphabet[(triple >>> 18) & 63]
    out += base64Alphabet[(triple >>> 12) & 63]
    out += has1 ? base64Alphabet[(triple >>> 6) & 63] : '='
    out += has2 ? base64Alphabet[triple & 63] : '='
  }
  return out
}

export function formatProgramStatusReply(terminator: OscTerminator = 'st'): string {
  return `\x1b]7501;${programStatusQueryReply}${terminator === 'bel' ? '\x07' : '\x1b\\'}`
}

export function formatProgramStatusReport(
  report: {
    state: ProgramStatusState
    id?: string | null
    app?: string | null
    kind?: BlockedKind | null
    progress?: number | null
    title?: string | null
    msg?: string | null
  },
  terminator: OscTerminator = 'st',
): string {
  const pairs = [`state=${report.state}`]
  if (report.id) pairs.push(`id=${report.id}`)
  if (report.app) pairs.push(`app=${report.app}`)
  if (report.kind) pairs.push(`kind=${report.kind}`)
  if (report.progress !== undefined && report.progress !== null) pairs.push(`progress=${report.progress}`)
  if (report.title) pairs.push(`title=${encodeBase64Utf8(report.title)}`)
  if (report.msg) pairs.push(`msg=${encodeBase64Utf8(report.msg)}`)
  return `\x1b]7501;${pairs.join(':')}${terminator === 'bel' ? '\x07' : '\x1b\\'}`
}

/** Parse and validate the body of an OSC 7501 sequence (everything after `7501;`). */
export function parseProgramStatus(body: string, terminator: OscTerminator = 'st'): ProgramStatusCommand | null {
  if (utf8Bytes(body) > programStatusLimits.maxBodyBytes) return null
  if (body === '?') return { kind: 'query', terminator }

  const lastValues = new Map<string, string>()
  for (const pair of body.split(':')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const key = trimAscii(pair.slice(0, eq))
    const value = trimAscii(pair.slice(eq + 1))

    if (utf8Bytes(key) > programStatusLimits.maxKeyBytes) return null

    // Validate limits on every occurrence, even one overridden later or containing disallowed bytes.
    if (key === 'id') {
      if (!validId(value)) return null
    } else if (key === 'app') {
      if (utf8Bytes(value) > programStatusLimits.maxAppBytes) return null
    } else if (key === 'title') {
      if (utf8Bytes(value) > programStatusLimits.maxTitleEncodedBytes) return null
    } else if (key === 'msg') {
      if (utf8Bytes(value) > programStatusLimits.maxMsgEncodedBytes) return null
    }

    if (valuePattern.test(value)) lastValues.set(key, value)
  }

  const rawState = lastValues.get('state')
  if (!rawState || !(programStatusStates as readonly string[]).includes(rawState)) return null
  const state = rawState as ProgramStatusState

  let title: string | null = null
  const rawTitle = lastValues.get('title')
  if (rawTitle !== undefined) {
    const decoded = decodeBase64Text(rawTitle, programStatusLimits.maxTitleBytes)
    if (decoded === null) return null
    if (decoded.length > 0) title = decoded
  }

  let msg: string | null = null
  const rawMsg = lastValues.get('msg')
  if (rawMsg !== undefined) {
    const decoded = decodeBase64Text(rawMsg, programStatusLimits.maxMsgBytes)
    if (decoded === null) return null
    if (decoded.length > 0) msg = decoded
  }

  const rawApp = lastValues.get('app')
  const app = rawApp !== undefined && isName(rawApp) ? rawApp : null

  const rawKind = lastValues.get('kind')
  const kind =
    state === 'blocked' && rawKind !== undefined && (blockedKinds as readonly string[]).includes(rawKind)
      ? (rawKind as BlockedKind)
      : null

  const rawProgress = lastValues.get('progress')
  const progress =
    (state === 'working' || state === 'blocked') && rawProgress !== undefined ? parseProgress(rawProgress) : null

  const id = lastValues.get('id') ?? null

  return {
    kind: 'report',
    report: { state, id, app, kind, progress, title, msg },
  }
}

interface ProgramStatusHandlers {
  output(text: string): void
  reply(sequence: string): void
  report(report: ProgramStatusReport): void
}

/** Find the end of a VT control string starting after its introducer.
 * Returns `{ contentEnd, nextIndex, terminator }` for a validly terminated string,
 * or `{ contentEnd: -1, nextIndex }` if aborted or unterminated. */
function scanControlString(
  text: string,
  start: number,
  allowBel: boolean,
): { contentEnd: number; nextIndex: number; terminator: OscTerminator | null } {
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\x07' && allowBel) return { contentEnd: i, nextIndex: i + 1, terminator: 'bel' }
    if (ch === '\x9c') return { contentEnd: i, nextIndex: i + 1, terminator: 'st' }
    if (ch === '\x18' || ch === '\x1a') return { contentEnd: -1, nextIndex: i + 1, terminator: null }
    if (ch === '\x1b') {
      if (i + 1 < text.length && text[i + 1] === '\\') return { contentEnd: i, nextIndex: i + 2, terminator: 'st' }
      // Another ESC sequence aborts the string; let the outer loop handle ESC cleanly.
      return { contentEnd: -1, nextIndex: i, terminator: null }
    }
  }
  return { contentEnd: -1, nextIndex: text.length, terminator: null }
}

/** Walk a complete-sequence VT chunk in order: strip OSC 7501 sequences from
 * terminal output, answer `?` queries immediately in stream order (before any
 * trailing DA1 sentinel), and deliver valid reports. */
export function processProgramStatus(text: string, handlers: ProgramStatusHandlers): void {
  if (!text) return
  if (!text.includes('7501;')) {
    handlers.output(text)
    return
  }

  let flushFrom = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    let isOsc = false
    let isOtherString = false
    let bodyStart = 0

    if (ch === '\x1b' && i + 1 < text.length) {
      const next = text[i + 1]
      if (next === ']') {
        isOsc = true
        bodyStart = i + 2
      } else if (next === 'P' || next === 'X' || next === '^' || next === '_') {
        isOtherString = true
        bodyStart = i + 2
      }
    } else if (ch === '\x9d') {
      isOsc = true
      bodyStart = i + 1
    } else if (ch === '\x90' || ch === '\x98' || ch === '\x9e' || ch === '\x9f') {
      isOtherString = true
      bodyStart = i + 1
    }

    if (isOtherString) {
      i = scanControlString(text, bodyStart, false).nextIndex
      continue
    }

    if (isOsc) {
      const scanned = scanControlString(text, bodyStart, true)
      if (text.startsWith('7501;', bodyStart) && scanned.terminator !== null) {
        if (i > flushFrom) handlers.output(text.slice(flushFrom, i))
        const parsed = parseProgramStatus(text.slice(bodyStart + 5, scanned.contentEnd), scanned.terminator)
        if (parsed?.kind === 'query') handlers.reply(formatProgramStatusReply(parsed.terminator))
        else if (parsed?.kind === 'report') handlers.report(parsed.report)
        flushFrom = scanned.nextIndex
      }
      i = scanned.nextIndex
      continue
    }

    i++
  }

  if (flushFrom < text.length) handlers.output(text.slice(flushFrom))
}

/** Convenience pure extractor returning filtered output, query replies, and valid reports. */
export function extractProgramStatus(text: string): {
  output: string
  replies: string[]
  reports: ProgramStatusReport[]
} {
  const outputs: string[] = []
  const replies: string[] = []
  const reports: ProgramStatusReport[] = []
  processProgramStatus(text, {
    output: chunk => outputs.push(chunk),
    reply: seq => replies.push(seq),
    report: report => reports.push(report),
  })
  return { output: outputs.join(''), replies, reports }
}
