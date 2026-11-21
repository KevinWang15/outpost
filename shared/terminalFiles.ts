import { imageProblem } from './images'
import { maxSessionFileBytes, sessionFileId, type SessionFile } from './sessionFiles'

// One request in flight per reader. A small response leaves room for interactive
// output and avoids buffering a file on the relay or the persistent PTY process.
export const terminalFileChunk = 64 * 1024

export interface FileRead {
  type: 'file-read'
  id: string
  file: string
  offset: number
}

export function validFileRead(request: FileRead) {
  return (
    sessionFileId(request.file) &&
    Number.isSafeInteger(request.offset) &&
    request.offset >= 0 &&
    request.offset <= maxSessionFileBytes &&
    request.offset % terminalFileChunk === 0
  )
}

export type TerminalFileReader = (file: SessionFile, signal: AbortSignal) => Promise<Blob>

export interface ImageWrite {
  type: 'image-write'
  id: string
  transfer: string
  mime: string
  size: number
  offset: number
  chunk: string
}

export function validImageWrite(request: ImageWrite) {
  const bytes = Math.min(terminalFileChunk, request.size - request.offset)
  return (
    typeof request.transfer === 'string' &&
    /^[a-zA-Z0-9_-]{1,80}$/.test(request.transfer) &&
    !imageProblem({ type: request.mime, size: request.size }) &&
    Number.isSafeInteger(request.offset) &&
    request.offset >= 0 &&
    request.offset % terminalFileChunk === 0 &&
    bytes > 0 &&
    typeof request.chunk === 'string' &&
    request.chunk.length === 4 * Math.ceil(bytes / 3)
  )
}
