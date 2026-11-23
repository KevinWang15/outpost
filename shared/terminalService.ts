/** Release and protocol contract shared by the server, renderer and target binary. */
export const terminalService = {
  version: '3.0.5',
  protocol: 9,
  repository: 'KevinWang15/outpost',
  scrollback: 10_000,
  maxCols: 400,
  maxRows: 200,
} as const

export type Scrollback = number | 'unlimited'

// Native grid coordinates are signed 32-bit rows. Both engines allocate cells as output arrives.
export const maxScrollbackLines = 0x7fffffff - terminalService.maxRows
export function validScrollback(value: unknown): value is Scrollback {
  return (
    value === 'unlimited' ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maxScrollbackLines)
  )
}
export function scrollbackLines(value: Scrollback = terminalService.scrollback): number {
  return value === 'unlimited' ? maxScrollbackLines : value
}

export function terminalSize(cols: number, rows: number) {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 2 &&
    rows >= 2 &&
    cols <= terminalService.maxCols &&
    rows <= terminalService.maxRows
  )
}
