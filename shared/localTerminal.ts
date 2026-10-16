import type { ImageMediaType } from './model'

export interface ShellProfileSummary {
  id: string
  name: string
}

export type LocalTerminalEvent = { generation: string } & (
  | { type: 'ready'; name: string; cols: number; rows: number }
  | { type: 'data'; data: string }
  | { type: 'geometry'; cols: number; rows: number }
  | { type: 'exit'; code: number }
)

/** Only the packaged local terminal page receives this capability. The native
 * process resolves the owning tab; callers cannot choose another tab or command. */
export interface LocalTerminalBridge {
  onEvent(listener: (event: LocalTerminalEvent) => void): () => void
  start(generation: string, cols: number, rows: number): Promise<void>
  write(generation: string, data: string | Uint8Array): Promise<void>
  resize(generation: string, cols: number, rows: number): Promise<void>
  acknowledge(generation: string, length: number): void
  stop(generation: string): Promise<void>
  pasteImage(generation: string, data: string, mediaType: ImageMediaType): Promise<string>
}
