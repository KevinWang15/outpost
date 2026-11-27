import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { CheckpointState } from '../../shared/terminalState'
import type { TerminalRendering } from '../../shared/terminal/rendering'
import { CheckpointReader } from '../../shared/terminalCheckpoint'
import { terminalService, terminalSize, scrollbackLines, type Scrollback } from '../../shared/terminalService'
import type { ServerMessage } from '../../shared/protocol'
import { bufferControls, terminalControls } from './checkpoint-modes'
import { errorMessage, type Emit } from './helper-protocol'

/** Decodes V3 terminal checkpoints and live bytes into ordered GPUI pane events. */
export class NativeRendering implements TerminalRendering {
  private scratch?: Terminal
  private reader?: CheckpointReader
  private serializer?: SerializeAddon
  private state?: CheckpointState
  private links: Record<'normal' | 'alt', number[][]> = { normal: [], alt: [] }
  private history: number = terminalService.scrollback
  private linkUris = new Map<number, string>()
  private live = false
  private callbacks = new Map<number, () => void>()

  constructor(
    readonly pane: number,
    private emit: Emit,
    private nextSeq: () => number,
    private failed: (reason: string) => void,
  ) {}

  begin(scrollback?: Scrollback) {
    this.dispose()
    this.history = scrollbackLines(scrollback)
    this.live = false
  }

  dispose() {
    this.scratch?.dispose()
    this.scratch = undefined
    this.reader = undefined
    this.serializer = undefined
    this.callbacks.clear()
    this.linkUris.clear()
    this.state = undefined
    this.links = { normal: [], alt: [] }
    this.live = false
  }

  barrier(done: () => void, event = 'barrier', payload: object = {}) {
    const seq = this.nextSeq()
    this.callbacks.set(seq, done)
    this.emit(event, { pane: this.pane, seq, ...payload })
  }

  ack(seq: number) {
    const done = this.callbacks.get(seq)
    this.callbacks.delete(seq)
    done?.()
  }

  private bytes(bytes: Uint8Array) {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let i = 0; i < buf.length; i += 65536)
      this.emit('output', { pane: this.pane, data: buf.subarray(i, i + 65536).toString('base64') })
  }

  output(bytes: Uint8Array, done: () => void) {
    if (!this.live) return this.failed('Live output arrived before the checkpoint.')
    this.bytes(bytes)
    this.barrier(done)
  }

  restore(msg: Extract<ServerMessage, { type: 'restore' | 'clear' | 'geometry' }>, done: () => void) {
    try {
      if (msg.type === 'geometry') {
        if (!this.live || !terminalSize(msg.cols, msg.rows)) throw new Error('Invalid terminal geometry')
        this.emit('geometry', { pane: this.pane, cols: msg.cols, rows: msg.rows })
      } else if (msg.type === 'clear') {
        if (!this.live) throw new Error('Unexpected clear')
        this.emit('clear', { pane: this.pane })
      } else {
        const part = msg.checkpoint
        if (part.part === 'begin') {
          if (this.live || this.scratch || !terminalSize(part.cols, part.rows))
            throw new Error('Invalid checkpoint header')
          this.scratch = new Terminal({
            allowProposedApi: true,
            cols: part.cols,
            rows: part.rows,
            scrollback: this.history,
          })
          this.state = part.state
          this.reader = new CheckpointReader(this.scratch, this.history)
          this.serializer = new SerializeAddon()
          this.scratch.loadAddon(this.serializer)
        }
        if (!this.reader || !this.scratch || !this.serializer) throw new Error('Missing checkpoint header')
        this.reader.accept(part)
        if (part.part === 'links') for (const [id, link] of part.links) this.linkUris.set(id, link.uri)
        if (part.part === 'lines')
          part.lines.forEach((line, index) => {
            for (const [col, , link] of line.extended)
              if (link) this.links[part.buffer].push([part.first + index, col, link])
          })
        // The V3 server owns the canonical xterm cell snapshot. Decode it once
        // with the shared validator, then dispose of the temporary conversion grid.
        if (part.part === 'end') {
          const restored = this.serializer.serialize()
          this.emit('reset', { pane: this.pane, cols: this.scratch.cols, rows: this.scratch.rows })
          const state = this.state!,
            cols = this.scratch.cols,
            rows = this.scratch.rows
          const metadata = (buffer: 'normal' | 'alt') => {
            const buf = state[buffer]
            this.bytes(Buffer.from(bufferControls(state, buf, cols, rows)))
            // Link URIs are metadata, never executable terminal escapes.
            const list = this.links[buffer]
            for (let i = 0; i < list.length; i += 256) {
              this.emit('links', {
                pane: this.pane,
                cells: list.slice(i, i + 256).flatMap(([line, col, id]) => {
                  const uri = this.linkUris.get(id)
                  return uri && uri.length <= 8192 ? [[line - buf.ybase, col, String(id), uri]] : []
                }),
              })
            }
            this.emit('cursor', { pane: this.pane, x: buf.x, y: buf.y })
          }
          if (state.active === 'alt') {
            const normal = this.serializer.serialize({ excludeAltBuffer: true, excludeModes: true })
            this.bytes(Buffer.from(normal))
            metadata('normal')
            this.bytes(Buffer.from(restored.slice(normal.length)))
          } else this.bytes(Buffer.from(restored))
          metadata(state.active)
          this.bytes(Buffer.from(terminalControls(state)))
          if (state.dec.origin) {
            this.bytes(Buffer.from('\x1b[?6h'))
            this.emit('cursor', { pane: this.pane, x: state[state.active].x, y: state[state.active].y })
          }
          this.linkUris.clear()
          this.state = undefined
          this.links = { normal: [], alt: [] }
          this.scratch.dispose()
          this.scratch = undefined
          this.reader = undefined
          this.serializer = undefined
          this.live = true
        } else {
          done()
          return
        }
      }
      this.barrier(done)
    } catch (error) {
      this.failed(errorMessage(error))
    }
  }

  flush(done: () => void) {
    if (this.live) this.barrier(done)
    else this.failed('Incomplete terminal checkpoint')
  }
}
