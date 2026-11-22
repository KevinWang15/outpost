import type { Attributes, BufferState, CheckpointState } from '../../shared/terminalState'

// V3 packs attributes using the xterm 6 cell schema. Only numbers and fixed
// control sequences are emitted here, never terminal titles or link payloads.
function rendition(attributes: Attributes) {
  const { fg, bg } = attributes
  const sgr = [0]
  for (const [value, mask, code] of [
    [fg, 0x08000000, 1],
    [bg, 0x08000000, 2],
    [bg, 0x04000000, 3],
    [fg, 0x10000000, 4],
    [fg, 0x20000000, 5],
    [fg, 0x04000000, 7],
    [fg, 0x40000000, 8],
    [fg, 0x80000000, 9],
  ]) {
    if (value & mask) sgr.push(code)
  }
  for (const [value, code] of [
    [fg, 38],
    [bg, 48],
  ]) {
    const mode = (value >>> 24) & 3
    if (mode === 3) sgr.push(code, 2, (value >>> 16) & 255, (value >>> 8) & 255, value & 255)
    else if (mode) sgr.push(code, 5, value & 255)
  }
  return '\x1b[' + sgr.join(';') + 'm'
}
export function bufferControls(state: CheckpointState, buf: BufferState, cols: number, rows: number) {
  const coord = (value: number, limit: number) =>
    Number.isInteger(value) ? Math.max(0, Math.min(value, limit - 1)) + 1 : 1
  const cursor = (x: number, y: number) => '\x1b[' + coord(y, rows) + ';' + coord(x, cols) + 'H'
  let controls = '\x1b[?6l\x1b[3g'
  for (const key of Object.keys(buf.tabs)) {
    const column = Number(key)
    if (buf.tabs[column] && Number.isInteger(column) && column >= 0 && column < cols)
      controls += cursor(column, 0) + '\x1bH'
  }
  controls += '\x1b[' + coord(buf.scrollTop, rows) + ';' + coord(buf.scrollBottom, rows) + 'r'
  controls += cursor(buf.savedX, buf.savedY - buf.ybase) + rendition(buf.savedAttributes) + '\x1b7'
  controls += cursor(buf.x, buf.y) + rendition(state.attributes)
  return controls
}
export function terminalControls(state: CheckpointState) {
  let controls = state.cursorHidden ? '\x1b[?25l' : '\x1b[?25h'
  if (state.mouseEncoding === 'SGR') controls += '\x1b[?1006h'
  for (const [key, color] of Object.entries(state.colors)) {
    const index = Number(key)
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index > 258 ||
      !Array.isArray(color) ||
      color.length !== 3 ||
      !color.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    )
      continue
    const code = index < 256 ? '4;' + index : String(index - 256 + 10)
    controls += '\x1b]' + code + ';rgb:' + color.map(n => n.toString(16).padStart(2, '0')).join('/') + '\x1b\\'
  }
  return controls
}
