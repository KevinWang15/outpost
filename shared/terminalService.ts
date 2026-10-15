/** Release and protocol contract shared by the server, renderer and target binary. */
export const terminalService = {
  version: '1.0.1',
  protocol: 1,
  repository: 'KevinWang15/outpost',
  executable: 'outpost-terminal',
  scrollback: 10_000,
  maxCols: 400,
  maxRows: 200,
} as const

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
