import { maxSessionFileBytes, maxSessionFiles, parseSessionFile, type SessionFile } from '../shared/sessionFiles'
import { AppError } from './errors'
import { protocolResult, runCommandBytes, runProtocol } from './process'
import { runtimeOperation } from './runtime'
import type { TargetContext } from './sessions'

/** Attachment I/O has its own requests; file bytes never enter the live PTY stream. */
export class SessionFileClient {
  constructor(private env: NodeJS.ProcessEnv = process.env) {}
  private command(context: TargetContext, action: string, id: string, fileId?: string) {
    const operation = runtimeOperation({ action, id, fileId })
    return { ...context.transport.runtime(operation.script), input: operation.input }
  }
  async list(context: TargetContext, id: string, signal: AbortSignal): Promise<SessionFile[]> {
    const files = await runProtocol<unknown>(this.command(context, 'files-list', id), '', {
      env: this.env,
      signal,
      readOnly: true,
    })
    if (!Array.isArray(files) || files.length > maxSessionFiles) throw new AppError('Invalid session file list.', 502)
    return files.map(parseSessionFile)
  }
  async remove(context: TargetContext, id: string, fileId: string) {
    await runProtocol(this.command(context, 'files-remove', id, fileId), '', { env: this.env })
  }
  async read(context: TargetContext, id: string, fileId: string, signal: AbortSignal) {
    const command = this.command(context, 'files-read', id, fileId)
    const result = await runCommandBytes(command, '', {
      env: this.env,
      signal,
      readOnly: true,
      maxOutputBytes: maxSessionFileBytes + 16384,
      timeoutMs: 120_000,
    })
    const marker = Buffer.from('OUTPOST_FILE:')
    const start = result.stdout.indexOf(marker)
    const end = result.stdout.indexOf(10, Math.max(0, start))
    if (result.code !== 0 || start < 0 || start > 8192 || end < 0 || end - start > 4096) {
      const envelope = protocolResult(result.stdout.subarray(0, 16384).toString('utf8'))
      if (envelope && !envelope.ok) throw envelope.error
      throw new AppError('Could not read the session file. Check the target and retry.', 502)
    }
    const file = parseSessionFile(JSON.parse(result.stdout.subarray(start + marker.length, end).toString('utf8')))
    const bytes = result.stdout.subarray(end + 1)
    if (file.id !== fileId || bytes.length !== file.size)
      throw new AppError('Session file transfer was incomplete.', 502)
    return { file, bytes }
  }
}
