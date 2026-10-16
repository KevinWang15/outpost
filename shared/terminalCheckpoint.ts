/* eslint-disable @typescript-eslint/no-explicit-any */
import { terminalService, terminalSize } from './terminalService'
import { terminalTheme } from './terminalTheme'
import type { Attributes, BufferState, CellLine, Checkpoint, CheckpointState } from './terminalState'

/** The only xterm-internal adapter in Outpost. Pinned to the 6.0 buffer layout
 * (headless 6.0.0 / our browser 6.0.1 patch). A schema bump is required when
 * upgrading that layout. We transfer cells, not replayed escape sequences:
 * restoring cannot ring bells, run clipboard commands or answer old queries.
 * Snapshot parts are bounded and share output ordering/backpressure. */
interface TerminalLike {
  cols: number
  rows: number
  reset(): void
  resize(cols: number, rows: number): void
  refresh?(start: number, end: number): void
}
type CapturedLine = Omit<CellLine, 'cells'> & { cells: Uint32Array }

function core(terminal: TerminalLike): any {
  const value = (terminal as any)._core
  if (!value?._bufferService?.buffers || !value?._inputHandler?._curAttrData)
    throw new Error('Unsupported xterm checkpoint engine')
  return value
}

const attributes = (value: any): Attributes => ({
  fg: value.fg,
  bg: value.bg,
  ext: value.extended._ext,
  url: value.extended.urlId,
})
function restoreAttributes(target: any, source: Attributes) {
  target.fg = source.fg
  target.bg = source.bg
  target.extended = target.extended.clone()
  target.extended.ext = source.ext
  target.extended.urlId = source.url
}

function encode(data: Uint32Array): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  let text = ''
  for (let index = 0; index < bytes.length; index += 4096)
    text += String.fromCharCode(...bytes.subarray(index, index + 4096))
  return btoa(text)
}

const bufferState = (buffer: any): BufferState => ({
  x: buffer.x,
  y: buffer.y,
  ybase: buffer.ybase,
  scrollTop: buffer.scrollTop,
  scrollBottom: buffer.scrollBottom,
  tabs: buffer.tabs,
  savedX: buffer.savedX,
  savedY: buffer.savedY,
  savedCharset: buffer.savedCharset,
  savedAttributes: attributes(buffer.savedCurAttrData),
})

/** Capture owned cells and metadata atomically. Encoding and transport can then
 * yield between parts while the live PTY continues changing its own buffers. */
export function checkpoint(terminal: TerminalLike): Generator<Checkpoint> {
  const c = core(terminal),
    buffers = c._bufferService.buffers,
    input = c._inputHandler
  if (input._parser.currentState !== 0) throw new Error('Checkpoint requires a complete terminal sequence')
  const begin: Checkpoint = {
    part: 'begin',
    version: 2,
    cols: terminal.cols,
    rows: terminal.rows,
    state: structuredClone({
      active: buffers.active === buffers.alt ? 'alt' : 'normal',
      normal: bufferState(buffers.normal),
      alt: bufferState(buffers.alt),
      modes: c.coreService.modes,
      dec: c.coreService.decPrivateModes,
      cursorBlink: c.optionsService.rawOptions.cursorBlink,
      cursorHidden: c.coreService.isCursorHidden,
      cursorInitialized: c.coreService.isCursorInitialized,
      mouseProtocol: c.coreMouseService.activeProtocol,
      mouseEncoding: c.coreMouseService.activeEncoding,
      attributes: attributes(input._curAttrData),
      charsets: c._charsetService._charsets,
      glevel: c._charsetService.glevel,
      title: input._windowTitle,
      icon: input._iconName,
      titleStack: input._windowTitleStack,
      iconStack: input._iconNameStack,
      join: input._parser.precedingJoinState,
      links: [...c._oscLinkService._dataByLinkId].map(([id, entry]: any) => [id, entry.data]),
      nextLink: c._oscLinkService._nextId,
      colors: c.outpostColors ?? {},
    }),
  }
  const captured: { name: 'normal' | 'alt'; lines: CapturedLine[] }[] = []
  for (const name of ['normal', 'alt'] as const) {
    const buffer = buffers[name]
    const lines: CapturedLine[] = []
    for (let index = 0; index < buffer.lines.length; index++) {
      const line = buffer.lines.get(index)
      // Most history rows end in many identical blank cells. Preserve the exact
      // final cell (including its style), storing that run only once.
      let columns = terminal.cols
      while (columns > 1) {
        const end = (columns - 1) * 3
        if (
          line._data[end] !== line._data[end - 3] ||
          line._data[end + 1] !== line._data[end - 2] ||
          line._data[end + 2] !== line._data[end - 1]
        )
          break
        columns--
      }
      lines.push({
        cells: line._data.slice(0, columns * 3),
        repeat: terminal.cols - columns,
        wrapped: line.isWrapped,
        combined: { ...line._combined },
        extended: Object.entries(line._extendedAttrs)
          .filter(([col, attr]) => attr && Number(col) < terminal.cols)
          .map(([col, attr]: any) => [Number(col), attr._ext, attr.urlId]),
      })
    }
    captured.push({ name, lines })
  }
  return parts()

  function* parts(): Generator<Checkpoint> {
    yield begin
    for (const { name, lines } of captured) {
      for (let first = 0; first < lines.length; first += 8) {
        yield {
          part: 'lines',
          buffer: name,
          first,
          lines: lines.slice(first, first + 8).map(line => ({ ...line, cells: encode(line.cells) })),
        }
      }
    }
    yield { part: 'end' }
  }
}

export class CheckpointReader {
  private state: CheckpointState | null = null
  constructor(private terminal: TerminalLike) {}

  accept(part: Checkpoint) {
    const terminal = this.terminal
    if (part.part === 'begin') {
      if (part.version !== 2 || !terminalSize(part.cols, part.rows)) throw new Error('Unsupported terminal checkpoint')
      terminal.reset()
      terminal.resize(part.cols, part.rows)
      const c = core(terminal)
      c._bufferService.buffers.normal.lines.length = 0
      c._bufferService.buffers.alt.lines.length = 0
      this.state = part.state
      return
    }
    if (!this.state) throw new Error('Missing checkpoint header')
    const c = core(terminal),
      buffers = c._bufferService.buffers,
      input = c._inputHandler
    if (part.part === 'lines') {
      if (!['normal', 'alt'].includes(part.buffer) || part.lines.length > 8) throw new Error('Invalid checkpoint lines')
      const buffer = buffers[part.buffer]
      const limit = terminal.rows + (part.buffer === 'normal' ? terminalService.scrollback : 0)
      if (part.first !== buffer.lines.length || part.first + part.lines.length > limit)
        throw new Error('Invalid checkpoint length')
      for (const data of part.lines) {
        const bytes = Uint8Array.from(atob(data.cells), char => char.charCodeAt(0))
        const columns = bytes.length / 12
        if (
          !Number.isInteger(columns) ||
          columns < 1 ||
          columns > terminal.cols ||
          !Number.isInteger(data.repeat) ||
          data.repeat !== terminal.cols - columns
        )
          throw new Error('Invalid checkpoint cells')
        const line = buffer.getBlankLine(input._curAttrData, data.wrapped)
        const cells = new Uint32Array(bytes.buffer)
        line._data.set(cells)
        const last = (columns - 1) * 3
        for (let column = columns; column < terminal.cols; column++) {
          line._data[column * 3] = cells[last]
          line._data[column * 3 + 1] = cells[last + 1]
          line._data[column * 3 + 2] = cells[last + 2]
        }
        line._combined = { ...data.combined }
        for (const [column, ext, url] of data.extended) {
          if (!Number.isInteger(column) || column < 0 || column >= terminal.cols)
            throw new Error('Invalid cell attribute')
          const attr = input._curAttrData.extended.clone()
          attr.ext = ext
          attr.urlId = url
          line._extendedAttrs[column] = attr
        }
        buffer.lines.push(line)
      }
      return
    }
    if (part.part !== 'end') throw new Error('Invalid checkpoint part')
    const state = this.state
    if (state.active === 'alt') buffers.activateAltBuffer()
    for (const name of ['normal', 'alt'] as const) {
      const buffer = buffers[name],
        saved = state[name]
      for (const field of ['x', 'y', 'ybase', 'scrollTop', 'scrollBottom', 'savedX', 'savedY'] as const)
        buffer[field] = saved[field]
      buffer.ydisp = buffer.ybase
      buffer.tabs = { ...saved.tabs }
      buffer.savedCharset = saved.savedCharset
      restoreAttributes(buffer.savedCurAttrData, saved.savedAttributes)
    }
    c.coreService.modes = { ...state.modes }
    c.coreService.decPrivateModes = { ...state.dec }
    c.optionsService.options.cursorBlink = state.cursorBlink
    c.coreService.isCursorHidden = state.cursorHidden
    c.coreService.isCursorInitialized = state.cursorInitialized
    c.coreMouseService.activeProtocol = state.mouseProtocol
    c.coreMouseService.activeEncoding = state.mouseEncoding
    restoreAttributes(input._curAttrData, state.attributes)
    c._charsetService._charsets = [...state.charsets]
    c._charsetService.setgLevel(state.glevel)
    input._windowTitle = state.title
    input._iconName = state.icon
    input._windowTitleStack = state.titleStack
    input._iconNameStack = state.iconStack
    input._parser.precedingJoinState = state.join
    c.outpostColors = { ...state.colors }
    if (c._themeService) {
      c._themeService.restoreColor()
      for (const [index, color] of Object.entries(state.colors))
        c._handleColorEvent([{ type: 1, index: Number(index), color }])
    }
    // Preserve OSC 8 IDs and attach their lifetime to the restored buffer lines.
    const links = c._oscLinkService
    links._dataByLinkId.clear()
    links._entriesWithId.clear()
    links._nextId = state.nextLink
    for (const [id, data] of state.links) {
      const entry: any = { id, data, lines: [], ...(data.id !== undefined ? { key: `${data.id};;${data.uri}` } : {}) }
      links._dataByLinkId.set(id, entry)
      if (entry.key) links._entriesWithId.set(entry.key, entry)
    }
    for (const name of ['normal', 'alt']) {
      const buffer = buffers[name]
      for (let row = 0; row < buffer.lines.length; row++) {
        const ids = new Set(Object.values(buffer.lines.get(row)._extendedAttrs).map((attr: any) => attr?.urlId))
        for (const id of ids) {
          const entry = links._dataByLinkId.get(id)
          if (!entry) continue
          const marker = buffer.addMarker(row)
          entry.lines.push(marker)
          marker.onDispose(() => links._removeMarkerFromLink(entry, marker))
        }
      }
    }
    c._bufferService._onScroll.fire(buffers.active.ydisp)
    terminal.refresh?.(0, terminal.rows - 1)
    this.state = null
  }
}

/** Only the target answers terminal queries. User input, mouse and focus events
 * still originate in the renderer. This avoids duplicate replies and allows
 * the harness to negotiate its terminal even while nobody is attached. */
export function remoteTerminalReplies(terminal: TerminalLike) {
  const service = core(terminal).coreService
  const original = service.triggerDataEvent
  service.triggerDataEvent = function (data: string, user = false) {
    if (user || data === '\x1b[I' || data === '\x1b[O') original.call(this, data, user)
  }
}

/** Headless has synchronous handlers only. Processing in the PTY callback
 * bounds the parser queue and makes checkpoints and resizes atomic. */
export function writeHeadless(terminal: TerminalLike, text: string) {
  core(terminal).writeSync(text)
}

/** The public fit addon uses cached cell metrics. Re-measure after visibility,
 * font loading or display changes without resizing/mutating either buffer. Keep
 * this browser-only private API alongside the other pinned xterm internals. */
export function refreshTerminalMetrics(terminal: TerminalLike) {
  core(terminal)._charSizeService?.measure()
}

/** Headless xterm emits color requests but has no browser theme service. Keep
 * the same palette and answer queries locally, including during disconnection. */
export function headlessColors(terminal: TerminalLike, reply: (data: string) => void) {
  const c = core(terminal)
  const names = [
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'brightBlack',
    'brightRed',
    'brightGreen',
    'brightYellow',
    'brightBlue',
    'brightMagenta',
    'brightCyan',
    'brightWhite',
  ] as const
  const rgb = (hex: string) => [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16))
  const defaults = names.map(name => rgb(terminalTheme[name]))
  const levels = [0, 95, 135, 175, 215, 255]
  for (let index = 0; index < 216; index++)
    defaults.push([levels[Math.floor(index / 36) % 6], levels[Math.floor(index / 6) % 6], levels[index % 6]])
  for (let index = 0; index < 24; index++) defaults.push([8 + index * 10, 8 + index * 10, 8 + index * 10])
  defaults.push(rgb(terminalTheme.foreground), rgb(terminalTheme.background), rgb(terminalTheme.cursor))
  c.outpostColors = {}
  c._inputHandler.onRequestReset(() => {
    c.outpostColors = {}
  })
  return c._inputHandler.onColor((requests: any[]) => {
    for (const request of requests) {
      if (request.type === 1) c.outpostColors[request.index] = request.color
      else if (request.type === 2) {
        if (request.index === undefined) {
          for (let index = 0; index < 256; index++) delete c.outpostColors[index]
        } else delete c.outpostColors[request.index]
      } else {
        const color: number[] = c.outpostColors[request.index] ?? defaults[request.index]
        const identifier = request.index < 256 ? `4;${request.index}` : String(request.index - 246)
        reply(
          `\x1b]${identifier};rgb:${color.map(channel => channel.toString(16).padStart(2, '0').repeat(2)).join('/')}\x1b\\`,
        )
      }
    }
  })
}
