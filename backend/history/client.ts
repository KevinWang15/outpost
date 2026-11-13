import type { HistoryBatch, HistoryCatalog, HistoryCheckpoint, HistorySource } from '../../shared/history'
import type { TargetContext } from '../sessions'

/** Native history reads on a machine, over its connection. */
export interface HistoryReader {
  catalog(context: TargetContext, after: string | null, signal: AbortSignal): Promise<HistoryCatalog>
  read(
    context: TargetContext,
    sources: { source: HistorySource; checkpoint: HistoryCheckpoint | null }[],
    signal: AbortSignal,
  ): Promise<HistoryBatch>
  message(
    context: TargetContext,
    input: object,
    signal: AbortSignal,
  ): Promise<{ text: string; totalChars: number; nextOffset: number | null }>
}

export const machineHistory: HistoryReader = {
  catalog: ({ machine }, after, signal) => machine.call('history.catalog', { after, limit: 50 }, { signal }),
  read: ({ machine }, sources, signal) => machine.call('history.read', { sources }, { signal, timeoutMs: 30_000 }),
  message: ({ machine }, input, signal) => machine.call('history.message', input, { signal }),
}
