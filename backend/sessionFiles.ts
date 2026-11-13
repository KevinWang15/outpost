import { maxSessionFileBytes, maxSessionFiles, parseSessionFile, type SessionFile } from '../shared/sessionFiles'
import { AppError } from './errors'
import { upload, type TargetContext } from './sessions'

/** A session's files on its machine, over the machine connection. File bytes
 * travel as streams and never enter a terminal or the model's context. */
export class SessionFileClient {
  async list({ machine }: TargetContext, id: string, signal: AbortSignal): Promise<SessionFile[]> {
    const files = await machine.call<unknown>('files.list', { session: id }, { signal })
    if (!Array.isArray(files) || files.length > maxSessionFiles) throw new AppError('Invalid session file list.', 502)
    return files.map(parseSessionFile)
  }
  async remove({ machine }: TargetContext, id: string, fileId: string) {
    await machine.call('files.remove', { session: id, file: fileId })
  }
  /** Store a file sent to the session's agent. */
  async receive({ machine }: TargetContext, id: string, name: string, data: Buffer, signal: AbortSignal) {
    const stream = await machine.open('file-receive', { session: id, name, size: data.length }, signal)
    return parseSessionFile(await upload(stream, data, signal))
  }
  async read({ machine }: TargetContext, id: string, fileId: string, signal: AbortSignal) {
    const stream = await machine.open('file-read', { session: id, file: fileId }, signal)
    const file = parseSessionFile(stream.opened)
    const parts: Buffer[] = []
    let size = 0
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      signal.addEventListener('abort', () => {
        stream.end()
        reject(new AppError('The download was cancelled.', 499))
      })
      stream.onData(chunk => {
        size += chunk.length
        if (size > maxSessionFileBytes) return reject(new AppError('Session file exceeds its size limit.', 502))
        parts.push(chunk)
      })
      stream.onClose(error => (error ? reject(error) : resolve(Buffer.concat(parts))))
    })
    if (bytes.length !== file.size) throw new AppError('Session file transfer was incomplete.', 502)
    return { file, bytes }
  }
}
