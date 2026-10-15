/** Current cell-checkpoint wire schema, independent of the xterm implementation. */
export type Checkpoint =
  | { part: 'begin'; version: 1; cols: number; rows: number; state: CheckpointState }
  | { part: 'lines'; buffer: 'normal' | 'alt'; first: number; lines: CellLine[] }
  | { part: 'end' }

export interface CellLine {
  cells: string
  wrapped: boolean
  combined: Record<number, string>
  extended: [number, number, number][]
}

export interface Attributes {
  fg: number
  bg: number
  ext: number
  url: number
}
type Charset = Record<string, string> | null
export interface BufferState {
  x: number
  y: number
  ybase: number
  scrollTop: number
  scrollBottom: number
  tabs: Record<number, boolean>
  savedX: number
  savedY: number
  savedCharset?: Charset
  savedAttributes: Attributes
}
export interface CheckpointState {
  active: 'normal' | 'alt'
  normal: BufferState
  alt: BufferState
  modes: Record<string, boolean>
  dec: Record<string, boolean | string | undefined>
  cursorBlink: boolean
  cursorHidden: boolean
  cursorInitialized: boolean
  mouseProtocol: string
  mouseEncoding: string
  attributes: Attributes
  charsets: Charset[]
  glevel: number
  title: string
  icon: string
  titleStack: string[]
  iconStack: string[]
  join: number
  links: [number, { id?: string; uri: string }][]
  nextLink: number
  colors: Record<number, [number, number, number]>
}
