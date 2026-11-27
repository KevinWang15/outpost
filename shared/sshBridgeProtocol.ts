// Experimental interactive SSH bridge protocol (shared/sshBridgeProtocol.ts).
//
// Two clean, single-format framings matching what PTYs pass verbatim in each direction:
//   - Remote -> Desktop (PTY output): `ESC ] 7770 ; outpost ; ssh ; <base64url-json> BEL`
//     (rides inside Outpost's existing OSC 7770 scanner; standard terminals ignore it).
//   - Desktop -> Remote (PTY input):  `\uE077outpost;ssh;<base64url-json>\uE078`
//     (UTF-8 Private Use Area delimiters U+E077/U+E078: Windows ConPTY's VtInputThread
//     swallows OSC sequences on input, whereas PUA UTF-8 passes byte-for-byte through
//     Windows ConPTY, WSL, macOS, and Linux PTYs with zero Escape-key latency).
//
// Turn off the whole machine-side experiment in one place by flipping `SSH_BRIDGE_ENABLED = false`
// (and `desktop/native/ssh_bridge/mod.rs::ENABLED = false` on the Desktop side).
import historyTools from './historyTools.json' with { type: 'json' }
import { isHarnessId, type HarnessId } from './harnesses'
import { imageExtensions, maxImageBytes, type ImageMediaType } from './images'
import type { ImagePasteMode } from './terminalFiles'

const isImageMediaType = (value: unknown): value is ImageMediaType =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(imageExtensions, value)

/** Master feature switch for the machine-side experimental SSH bridge. */
export const SSH_BRIDGE_ENABLED = true

export const SSH_BRIDGE_OSC = 7770
export const SSH_BRIDGE_PREFIX = 'outpost;ssh;'
export const SSH_BRIDGE_INPUT_START = '\uE077'
export const SSH_BRIDGE_INPUT_END = '\uE078'
/** Chunk payload size in raw bytes (16 KiB -> ~21.8 KiB base64 per frame). */
export const SSH_IMAGE_CHUNK_BYTES = 16 * 1024
/** Max in-flight image chunks in the sliding window (4 * 16 KiB = 64 KiB). */
export const SSH_IMAGE_WINDOW_CHUNKS = 4
/** Max UTF-8 bytes of one SSH bridge payload (after `7770;` or `\uE077`). */
export const MAX_SSH_BRIDGE_OSC_BYTES = 32 * 1024

const idPattern = /^[A-Za-z0-9_-]{1,64}$/

/** Outpost MCP tools allowed in standalone SSH mode (no registered Outpost session UUID). */
export const standaloneAgentToolNames = new Set<string>([
  ...historyTools.map(tool => tool.name),
  'list_machines',
  'list_sessions',
])

export const isStandaloneAgentTool = (tool: unknown): tool is string =>
  typeof tool === 'string' && standaloneAgentToolNames.has(tool)

/** Remote wrapper -> Desktop messages. */
export type SshRemoteMessage =
  | { v: 1; t: 'ready'; session: string; tool: HarnessId; clipboard: boolean }
  | { v: 1; t: 'bye'; session: string }
  | { v: 1; t: 'shell' }
  | { v: 1; t: 'img.ack'; id: string; next: number; chunkSize?: number }
  | { v: 1; t: 'img.done'; id: string; ok: true; mode: ImagePasteMode }
  | { v: 1; t: 'img.done'; id: string; ok: false; message: string }

/** Desktop -> Remote wrapper messages. */
export type SshDesktopMessage =
  | {
      v: 1
      t: 'img.begin'
      session: string
      id: string
      mime: ImageMediaType
      size: number
      mode: ImagePasteMode
    }
  | { v: 1; t: 'img.data'; id: string; offset: number; data: string }
  | { v: 1; t: 'img.cancel'; id: string }

export type SshBridgeMessage = SshRemoteMessage | SshDesktopMessage

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function toBase64Url(text: string): string {
  const bytes = encoder.encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(encoded: string): string | null {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return decoder.decode(bytes)
  } catch {
    return null
  }
}

/** Encode a Remote -> Desktop OSC 7770 frame. */
export function encodeSshBridgeOsc(message: SshBridgeMessage, terminator: 'bel' | 'st' = 'bel'): string {
  const encoded = toBase64Url(JSON.stringify(message))
  const end = terminator === 'st' ? '\x1b\\' : '\x07'
  return `\x1b]${SSH_BRIDGE_OSC};${SSH_BRIDGE_PREFIX}${encoded}${end}`
}

/** Encode a Desktop -> Remote input frame using ConPTY-safe PUA UTF-8 delimiters. */
export function encodeSshBridgeInput(message: SshDesktopMessage): string {
  const encoded = toBase64Url(JSON.stringify(message))
  return `${SSH_BRIDGE_INPUT_START}${SSH_BRIDGE_PREFIX}${encoded}${SSH_BRIDGE_INPUT_END}`
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && idPattern.test(value)
}

function validNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function parseSshBridgeOscData(data: string): SshBridgeMessage | null {
  if (data.length > MAX_SSH_BRIDGE_OSC_BYTES || !data.startsWith(SSH_BRIDGE_PREFIX)) return null
  const decoded = fromBase64Url(data.slice(SSH_BRIDGE_PREFIX.length))
  if (!decoded) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const raw = parsed as Record<string, unknown>
  if (raw.v !== 1 || typeof raw.t !== 'string') return null

  switch (raw.t) {
    case 'ready':
      if (!validId(raw.session) || !isHarnessId(raw.tool) || typeof raw.clipboard !== 'boolean') return null
      return { v: 1, t: 'ready', session: raw.session, tool: raw.tool, clipboard: raw.clipboard }
    case 'bye':
      if (!validId(raw.session)) return null
      return { v: 1, t: 'bye', session: raw.session }
    case 'shell':
      return { v: 1, t: 'shell' }
    case 'img.begin':
      if (
        !validId(raw.session) ||
        !validId(raw.id) ||
        !isImageMediaType(raw.mime) ||
        !validNonNegInt(raw.size) ||
        raw.size < 1 ||
        raw.size > maxImageBytes ||
        (raw.mode !== 'attachment' && raw.mode !== 'path')
      )
        return null
      return {
        v: 1,
        t: 'img.begin',
        session: raw.session,
        id: raw.id,
        mime: raw.mime,
        size: raw.size,
        mode: raw.mode,
      }
    case 'img.ack':
      if (!validId(raw.id) || !validNonNegInt(raw.next) || raw.next > maxImageBytes) return null
      if (raw.chunkSize !== undefined) {
        if (!validNonNegInt(raw.chunkSize) || raw.chunkSize < 512 || raw.chunkSize > SSH_IMAGE_CHUNK_BYTES) return null
        return { v: 1, t: 'img.ack', id: raw.id, next: raw.next, chunkSize: raw.chunkSize }
      }
      return { v: 1, t: 'img.ack', id: raw.id, next: raw.next }
    case 'img.data':
      if (
        !validId(raw.id) ||
        !validNonNegInt(raw.offset) ||
        raw.offset > maxImageBytes ||
        typeof raw.data !== 'string' ||
        raw.data.length === 0 ||
        raw.data.length > Math.ceil(SSH_IMAGE_CHUNK_BYTES / 3) * 4 + 4
      )
        return null
      return { v: 1, t: 'img.data', id: raw.id, offset: raw.offset, data: raw.data }
    case 'img.done':
      if (!validId(raw.id) || typeof raw.ok !== 'boolean') return null
      if (raw.ok) {
        if (raw.mode !== 'attachment' && raw.mode !== 'path') return null
        return { v: 1, t: 'img.done', id: raw.id, ok: true, mode: raw.mode }
      }
      if (typeof raw.message !== 'string' || raw.message.length > 512) return null
      return { v: 1, t: 'img.done', id: raw.id, ok: false, message: raw.message }
    case 'img.cancel':
      if (!validId(raw.id)) return null
      return { v: 1, t: 'img.cancel', id: raw.id }
    default:
      return null
  }
}

const INPUT_HEADER = encoder.encode(`${SSH_BRIDGE_INPUT_START}${SSH_BRIDGE_PREFIX}`)
const INPUT_END = encoder.encode(SSH_BRIDGE_INPUT_END) // [0xee, 0x81, 0xb8]
const MAX_SKIP_BYTES = 128 * 1024

type InputScannerState = 'ground' | 'header' | 'payload' | 'end'

/** Byte-stream splitter for Desktop -> Remote stdin (`\uE077outpost;ssh;<b64>\uE078`).
 * Never intercepts ESC or ASCII keystrokes, so normal typing and bare Escape have 0ms latency. */
export class SshBridgeInputScanner {
  private state: InputScannerState = 'ground'
  private headerIndex = 0
  private endIndex = 0
  private pending: number[] = []
  private payload: number[] = []
  private oversized = false
  private skipped = 0

  private clearPayload() {
    this.payload.length = 0
    this.oversized = false
    this.skipped = 0
  }

  private finishPayload(messages: SshBridgeMessage[]) {
    if (!this.oversized) {
      try {
        const text = SSH_BRIDGE_PREFIX + decoder.decode(new Uint8Array(this.payload))
        const parsed = parseSshBridgeOscData(text)
        if (parsed) messages.push(parsed)
      } catch {
        /* Invalid UTF-8 payload ignored. */
      }
    }
    this.clearPayload()
  }

  scan(bytes: Uint8Array): { passthrough: Uint8Array; messages: SshBridgeMessage[] } {
    if (this.state === 'ground' && !bytes.includes(INPUT_HEADER[0])) {
      return { passthrough: bytes, messages: [] }
    }
    const out: number[] = []
    const messages: SshBridgeMessage[] = []
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]
      switch (this.state) {
        case 'ground':
          if (b === INPUT_HEADER[0]) {
            this.pending = [b]
            this.headerIndex = 1
            this.state = 'header'
          } else {
            out.push(b)
          }
          break
        case 'header':
          if (b === INPUT_HEADER[this.headerIndex]) {
            this.pending.push(b)
            this.headerIndex++
            if (this.headerIndex === INPUT_HEADER.length) {
              this.pending.length = 0
              this.clearPayload()
              this.state = 'payload'
            }
          } else if (b === INPUT_HEADER[0]) {
            out.push(...this.pending)
            this.pending = [b]
            this.headerIndex = 1
          } else {
            out.push(...this.pending, b)
            this.pending.length = 0
            this.state = 'ground'
          }
          break
        case 'payload':
          if (b === INPUT_END[0]) {
            this.endIndex = 1
            this.state = 'end'
          } else if (b === 0x1b || b === 0x03 || b === 0x04) {
            // Abort malformed frame on control interrupt and forward the interrupt key cleanly.
            this.clearPayload()
            out.push(b)
            this.state = 'ground'
          } else if (!this.oversized && this.payload.length < MAX_SSH_BRIDGE_OSC_BYTES) {
            this.payload.push(b)
          } else {
            this.oversized = true
            this.skipped++
            if (this.skipped >= MAX_SKIP_BYTES) {
              this.clearPayload()
              this.state = 'ground'
            }
          }
          break
        case 'end':
          if (b === INPUT_END[this.endIndex]) {
            this.endIndex++
            if (this.endIndex === INPUT_END.length) {
              this.finishPayload(messages)
              this.state = 'ground'
            }
          } else if (this.endIndex === 2 && b === INPUT_HEADER[2]) {
            // Unexpected new start marker (`\uE077`) mid-payload: restart cleanly from header.
            this.clearPayload()
            this.pending = [INPUT_HEADER[0], INPUT_HEADER[1], INPUT_HEADER[2]]
            this.headerIndex = 3
            this.state = 'header'
          } else {
            // Non-terminator UTF-8 sequence inside payload aborts the malformed frame.
            this.clearPayload()
            this.state = 'ground'
          }
          break
      }
    }
    return { passthrough: new Uint8Array(out), messages }
  }
}
