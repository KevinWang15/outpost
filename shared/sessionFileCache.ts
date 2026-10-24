import type { SessionFile } from './sessionFiles'

interface Entry {
  controller: AbortController
  promise: Promise<Blob>
  bytes: number
}

/** Session-scoped, bounded LRU for immutable files. Pending reads are deduplicated
 * and serialized; failures are evicted so the next explicit request can retry.
 * A closing preview releases its URL, not a read another consumer may be using. */
export class SessionFileCache {
  private entries = new Map<string, Entry>()
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private load: (file: SessionFile, signal: AbortSignal) => Promise<Blob>,
    private limit = 64 * 1024 * 1024,
  ) {}

  read(file: SessionFile): Promise<Blob> {
    const existing = this.entries.get(file.id)
    if (existing) {
      this.entries.delete(file.id)
      this.entries.set(file.id, existing)
      return existing.promise
    }
    const controller = new AbortController()
    const entry: Entry = { controller, promise: Promise.resolve(new Blob()), bytes: 0 }
    entry.promise = this.queue
      .then(async () => {
        controller.signal.throwIfAborted()
        const blob = await this.load(file, AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]))
        controller.signal.throwIfAborted()
        entry.bytes = blob.size
        this.trim()
        return blob
      })
      .catch(error => {
        if (this.entries.get(file.id) === entry) this.entries.delete(file.id)
        throw error
      })
    this.entries.set(file.id, entry)
    this.queue = entry.promise.then(
      () => {},
      () => {},
    )
    return entry.promise
  }

  private trim() {
    let total = [...this.entries.values()].reduce((bytes, entry) => bytes + entry.bytes, 0)
    for (const [id, entry] of this.entries) {
      if (total <= this.limit) break
      if (!entry.bytes) continue
      this.entries.delete(id)
      total -= entry.bytes
    }
  }
  remove(id: string) {
    this.entries.get(id)?.controller.abort()
    this.entries.delete(id)
  }
  retain(files: SessionFile[]) {
    const ids = new Set(files.map(file => file.id))
    for (const id of this.entries.keys()) if (!ids.has(id)) this.remove(id)
  }
  clear() {
    for (const id of this.entries.keys()) this.remove(id)
  }
}
