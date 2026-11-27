import type { ServerMessage } from '../protocol'
import type { Scrollback } from '../terminalService'

export type ScreenUpdate = Extract<ServerMessage, { type: 'restore' | 'geometry' | 'clear' }>

/** Connections order output and geometry, then acknowledge completed rendering.
 * Remote attachments additionally restore a checkpoint before live output. */
export interface TerminalRendering {
  begin(scrollback?: Scrollback): void
  output(bytes: Uint8Array, rendered: () => void): void
  restore(message: ScreenUpdate, rendered: () => void): void
  flush(rendered: () => void): void
}
