import type { WebSocketRoute } from '@playwright/test'
import headless from '@xterm/headless'
import { checkpoint } from '../../shared/terminalCheckpoint'

/** Browser socket fixtures use the same initial checkpoint as the real service. */
export function restoreEmptyTerminal(socket: WebSocketRoute) {
  const params = new URL(socket.url()).searchParams
  const terminal = new headless.Terminal({
    cols: Number(params.get('cols')),
    rows: Number(params.get('rows')),
    allowProposedApi: true,
  })
  try {
    for (const part of checkpoint(terminal)) socket.send(JSON.stringify({ type: 'restore', checkpoint: part }))
    socket.send(JSON.stringify({ type: 'ready' }))
  } finally {
    terminal.dispose()
  }
}
