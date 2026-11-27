import type { DatabaseSync } from 'node:sqlite'
import type { HistoryBatch, HistoryMachine, HistorySearchInput, HistorySource } from '../../shared/history'
import { Signer } from '../signed'
import type { Embed } from './embeddings'
import { catalogSources, ingestBatch } from './ingest'
import { initializeSchema, openHistoryDb, parseCheckpoint, sourceKey } from './schema'
import { readContext, readHistoryMessage, readHistorySession, searchHistory, type Coverage } from './search'

export class HistoryIndex {
  readonly db: DatabaseSync
  private embedding: Promise<unknown> = Promise.resolve()
  private readonly cursors: Signer
  private closed = false

  constructor(
    path: string,
    secret: string,
    private embed: Embed,
  ) {
    this.cursors = new Signer(secret, 'history-cursor', 1024)
    this.db = openHistoryDb(path)
    try {
      initializeSchema(this.db)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  close() {
    this.closed = true
    this.db.close()
  }

  sourceKey(machine: string, source: string) {
    return sourceKey(machine, source)
  }

  checkpoints(machine: string, sources: HistorySource[]) {
    const lookup = this.db.prepare('SELECT checkpoint FROM sources WHERE id=?')
    return sources.map(source => ({
      source,
      checkpoint: parseCheckpoint(lookup.get(sourceKey(machine, source.id))?.checkpoint),
    }))
  }

  catalog(machine: HistoryMachine, sources: HistorySource[]) {
    return catalogSources(this.db, machine, sources)
  }

  ingest(machine: HistoryMachine, batch: HistoryBatch, commitCheckpoint = true) {
    return ingestBatch(this.db, machine, batch, commitCheckpoint)
  }

  coverage(machineIds: string[]): Coverage {
    if (!machineIds.length) return { searchableChunks: 0, embeddedChunks: 0, pendingChunks: 0 }
    const filter = machineIds.map(() => '?').join(',')
    const row = this.db
      .prepare(
        `SELECT count(*) total,coalesce(sum(embedded),0) embedded FROM (
          SELECT chunk_id,max(embedded) embedded FROM machine_chunks WHERE machine_id IN (${filter}) GROUP BY chunk_id)`,
      )
      .get(...machineIds)!
    const total = Number(row.total),
      embedded = Number(row.embedded)
    return { searchableChunks: total, embeddedChunks: embedded, pendingChunks: total - embedded }
  }

  embedPending(machineIds: string[], limit = 16) {
    const job = this.embedding.then(async () => {
      if (this.closed || !machineIds.length) return 0
      // Seek into each machine's pending index. Shared chunks need only one vector.
      const pending = this.db.prepare(`SELECT chunk_id,priority FROM machine_chunks
        WHERE machine_id=? AND embedded=0 ORDER BY priority DESC,chunk_id LIMIT ?`)
      const candidates = machineIds.flatMap(id => pending.all(id, limit))
      candidates.sort((a, b) => Number(b.priority) - Number(a.priority) || Number(a.chunk_id) - Number(b.chunk_id))
      const ids = [...new Set(candidates.map(row => Number(row.chunk_id)))].slice(0, limit)
      let completed = 0
      for (const id of ids) {
        const row = this.db.prepare('SELECT text FROM chunks WHERE id=?').get(id)!
        const vector = await this.embed(String(row.text), 'passage')
        if (this.closed) return completed
        this.db.exec('BEGIN IMMEDIATE')
        try {
          this.db
            .prepare('INSERT OR REPLACE INTO embeddings(chunk_id,embedding) VALUES(?,?)')
            .run(BigInt(id), new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength))
          this.db.prepare('UPDATE machine_chunks SET embedded=1 WHERE chunk_id=?').run(id)
          this.db.exec('COMMIT')
        } catch (error) {
          this.db.exec('ROLLBACK')
          throw error
        }
        completed++
      }
      return completed
    })
    this.embedding = job.catch(() => {})
    return job
  }

  search(input: HistorySearchInput, machineIds: string[]) {
    return searchHistory(this.db, this.cursors, this.embed, this.coverage(machineIds), input, machineIds)
  }

  context(
    input: { cursor?: string; sessionId?: string; direction?: string; limit?: number; maxChars?: number },
    machineIds: string[],
  ) {
    return readContext(this.db, this.cursors, input, machineIds)
  }

  readMessage(input: { cursor: string; offset?: number; limit?: number }, machineIds: string[]) {
    return readHistoryMessage(this.db, this.cursors, input, machineIds)
  }

  session(sessionId: string, machineIds: string[]) {
    return readHistorySession(this.db, this.cursors, sessionId, machineIds)
  }
}
