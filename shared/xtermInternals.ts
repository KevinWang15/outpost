import type { BufferState, CheckpointState } from './terminalState'

/** The exact private surface used by terminalCheckpoint.ts, pinned to xterm 6.0.
 * These are adapter types, not an alternative terminal API. Runtime shape checks
 * at the adapter entry point reject an incompatible engine before restoring it. */
export interface TerminalLike {
  cols: number
  rows: number
  reset(): void
  resize(cols: number, rows: number): void
  refresh?(start: number, end: number): void
}

interface Disposable {
  dispose(): void
}
interface Marker {
  onDispose(callback: () => void): Disposable
}
interface ExtendedAttributes {
  _ext: number
  ext: number
  urlId: number
  clone(): ExtendedAttributes
}
export interface XtermAttributes {
  fg: number
  bg: number
  extended: ExtendedAttributes
}
interface XtermLine {
  _data: Uint32Array
  _combined: Record<number, string>
  _extendedAttrs: Record<number, ExtendedAttributes>
  isWrapped: boolean
}
export interface XtermBuffer extends Omit<BufferState, 'savedAttributes'> {
  ydisp: number
  savedCurAttrData: XtermAttributes
  lines: {
    length: number
    get(index: number): XtermLine
    set(index: number, line: XtermLine | undefined): void
    push(line: XtermLine): void
  }
  getBlankLine(attributes: XtermAttributes, wrapped: boolean): XtermLine
  addMarker(row: number): Marker
  clearAllMarkers(): void
}
export interface XtermLink {
  id: number
  key?: string
  data: CheckpointState['links'][number][1]
  lines: Marker[]
}
type ColorRequest =
  { type: 0; index: number } | { type: 1; index: number; color: [number, number, number] } | { type: 2; index?: number }

export interface XtermCore {
  _bufferService: {
    buffers: { normal: XtermBuffer; alt: XtermBuffer; active: XtermBuffer; activateAltBuffer(): void }
    _onScroll: { fire(position: number): void }
    isUserScrolling: boolean
  }
  _inputHandler: {
    _curAttrData: XtermAttributes
    _parser: { currentState: number; precedingJoinState: number }
    _windowTitle: string
    _iconName: string
    _windowTitleStack: string[]
    _iconNameStack: string[]
    onRequestReset(callback: () => void): Disposable
    onColor(callback: (requests: ColorRequest[]) => void): Disposable
  }
  coreService: {
    modes: CheckpointState['modes']
    decPrivateModes: CheckpointState['dec']
    isCursorHidden: boolean
    isCursorInitialized: boolean
    triggerDataEvent(data: string, user?: boolean): void
  }
  optionsService: { rawOptions: { cursorBlink: boolean }; options: { cursorBlink: boolean } }
  coreMouseService: { activeProtocol: string; activeEncoding: string }
  _charsetService: {
    _charsets: CheckpointState['charsets']
    glevel: number
    setgLevel(level: number): void
  }
  _oscLinkService: {
    _dataByLinkId: Map<number, XtermLink>
    _entriesWithId: Map<string, XtermLink>
    _nextId: number
    _removeMarkerFromLink(entry: XtermLink, marker: Marker): void
  }
  writeSync(text: string): void
  _themeService?: { restoreColor(): void }
  _handleColorEvent(requests: ColorRequest[]): void
  _charSizeService?: { measure(): void }
  outpostColors?: CheckpointState['colors']
}
