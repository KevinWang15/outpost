import type { HistoryBatch, HistoryCatalog, HistoryCheckpoint, HistorySource } from '../../shared/history'
import { runProtocol, type Command } from '../process'
import { runtimeOperation } from '../runtime'
import type { TargetContext } from '../sessions'

export interface HistoryReader {
  catalog(context: TargetContext, after: string | null, signal: AbortSignal): Promise<HistoryCatalog>
  read(
    context: TargetContext,
    sources: { source: HistorySource; checkpoint: HistoryCheckpoint | null }[],
    signal: AbortSignal,
  ): Promise<HistoryBatch>
  bridge(context: TargetContext, socket: string): Command
  message?(
    context: TargetContext,
    input: object,
    signal: AbortSignal,
  ): Promise<{ text: string; totalChars: number; nextOffset: number | null }>
}
export class HistoryClient implements HistoryReader {
  constructor(private env: NodeJS.ProcessEnv = process.env) {}
  private command(context: TargetContext, request: object): Command {
    const operation = runtimeOperation(request)
    return { ...context.transport.runtime(operation.script), input: operation.input }
  }
  catalog(context: TargetContext, after: string | null, signal: AbortSignal) {
    return runProtocol<HistoryCatalog>(this.command(context, { action: 'history-catalog', after, limit: 50 }), '', {
      signal,
      env: this.env,
      readOnly: true,
      timeoutMs: 20000,
      maxOutputBytes: 2 * 1024 * 1024,
    })
  }
  read(
    context: TargetContext,
    sources: { source: HistorySource; checkpoint: HistoryCheckpoint | null }[],
    signal: AbortSignal,
  ) {
    return runProtocol<HistoryBatch>(this.command(context, { action: 'history-read', sources }), '', {
      signal,
      env: this.env,
      readOnly: true,
      timeoutMs: 20000,
      maxOutputBytes: 24 * 1024 * 1024,
    })
  }
  bridge(context: TargetContext, socket: string) {
    return this.command(context, { action: 'history-bridge', socket })
  }
  message(context: TargetContext, input: object, signal: AbortSignal) {
    return runProtocol<{ text: string; totalChars: number; nextOffset: number | null }>(
      this.command(context, { ...input, action: 'history-message' }),
      '',
      { signal, env: this.env, readOnly: true, timeoutMs: 20000, maxOutputBytes: 1024 * 1024 },
    )
  }
}
