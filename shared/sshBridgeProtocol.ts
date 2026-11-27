// Experimental interactive SSH bridge protocol (shared/sshBridgeProtocol.ts).
//
// Rides inside Outpost's private OSC 7770 namespace (`ESC ] 7770 ; outpost ; ssh ; <base64url-json> (BEL|ST)`)
// so standard terminals silently ignore it, Outpost Desktop reuses its single OSC 7770 scanner,
// and image paste + wrapper lifecycle work through jump hosts and WSL without extra ports.
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
/** Chunk payload size in raw bytes (16 KiB -> ~21.8 KiB base64 per OSC frame). */
export const SSH_IMAGE_CHUNK_BYTES = 16 * 1024
/** Max in-flight image chunks in the sliding window (4 * 16 KiB = 64 KiB). */
export const SSH_IMAGE_WINDOW_CHUNKS = 4
/** Max UTF-8 bytes of one OSC 7770 SSH bridge payload (after `7770;`). */
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

export function encodeSshBridgeOsc(message: SshBridgeMessage, terminator: 'bel' | 'st' = 'bel'): string {
  const encoded = toBase64Url(JSON.stringify(message))
  const end = terminator === 'st' ? '\x1b\\' : '\x07'
  return `\x1b]${SSH_BRIDGE_OSC};${SSH_BRIDGE_PREFIX}${encoded}${end}`
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

const OSC_HEADER = encoder.encode(`${SSH_BRIDGE_OSC};${SSH_BRIDGE_PREFIX}`)
const MAX_SKIP_BYTES = 128 * 1024

type ScannerState = 'ground' | 'esc' | 'header' | 'payload' | 'payloadEsc'

/** Byte-stream splitter that extracts `OSC 7770 ; outpost ; ssh ; ...` frames
 * while forwarding every other byte (including normal keystrokes & CSI/OSC escapes) verbatim.
 * Mirrors `desktop/native/terminal/osc7770.rs` so both directions share one framing model. */
export class SshBridgeOscScanner {
  private state: ScannerState = 'ground'
  private headerIndex = 0
  private pending: number[] = []
  private payload: number[] = []
  private oversized = false
  private skipped = 0

  private clearPayload() {
    this.payload.length = 0
    this.oversized = false
    this.skipped = 0
  }

  /** Flush an incomplete leading ESC if the user pressed a bare Escape key without following bytes. */
  flushPendingEsc(): Uint8Array | null {
    if (this.state === 'esc' && this.pending.length === 1 && this.pending[0] === 0x1b) {
      this.pending.length = 0
      this.state = 'ground'
      return new Uint8Array([0x1b])
    }
    return null
  }

  get hasPendingEsc(): boolean {
    return this.state === 'esc'
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
    if (this.state === 'ground' && !bytes.includes(0x1b)) {
      return { passthrough: bytes, messages: [] }
    }
    const out: number[] = []
    const messages: SshBridgeMessage[] = []
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]
      switch (this.state) {
        case 'ground':
          if (b === 0x1b) {
            this.pending = [0x1b]
            this.state = 'esc'
          } else {
            out.push(b)
          }
          break
        case 'esc':
          if (b === 0x5d /* ']' */) {
            this.pending.push(b)
            this.headerIndex = 0
            this.state = 'header'
          } else if (b === 0x1b) {
            out.push(...this.pending)
            this.pending = [0x1b]
          } else {
            out.push(...this.pending, b)
            this.pending.length = 0
            this.state = 'ground'
          }
          break
        case 'header':
          if (b === OSC_HEADER[this.headerIndex]) {
            this.pending.push(b)
            this.headerIndex++
            if (this.headerIndex === OSC_HEADER.length) {
              this.pending.length = 0
              this.clearPayload()
              this.state = 'payload'
            }
          } else if (b === 0x1b) {
            out.push(...this.pending)
            this.pending = [0x1b]
            this.state = 'esc'
          } else {
            out.push(...this.pending, b)
            this.pending.length = 0
            this.state = 'ground'
          }
          break
        case 'payload':
          if (b === 0x07) {
            this.finishPayload(messages)
            this.state = 'ground'
          } else if (b === 0x1b) {
            this.state = 'payloadEsc'
          } else if (b === 0x18 || b === 0x1a) {
            this.clearPayload()
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
        case 'payloadEsc':
          if (b === 0x5c /* '\\' */) {
            this.finishPayload(messages)
            this.state = 'ground'
          } else if (b === 0x1b) {
            this.clearPayload()
            this.pending = [0x1b]
            this.state = 'esc'
          } else if (b === 0x5d /* ']' */) {
            this.clearPayload()
            this.pending = [0x1b, 0x5d]
            this.headerIndex = 0
            this.state = 'header'
          } else {
            this.clearPayload()
            out.push(0x1b, b)
            this.state = 'ground'
          }
          break
      }
    }
    return { passthrough: new Uint8Array(out), messages }
  }
}
