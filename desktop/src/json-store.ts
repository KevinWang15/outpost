import { readFile } from 'node:fs/promises'
import { writeJsonFile } from '../../shared/node/jsonFile'

/** Serialized, atomic JSON file persistence. Publishes in memory only after disk commit. */
export class SerializedJsonStore<T> {
  private writes = Promise.resolve()
  value: T

  constructor(
    readonly path: string,
    initial: T,
    private serialize: (value: T) => unknown = value => value,
  ) {
    this.value = initial
  }

  async load(parse: (raw: unknown) => T, readError?: string) {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(this.path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw readError ? new Error(readError, { cause: error }) : error
    }
    this.value = parse(raw)
  }

  change(update: (current: T) => T): Promise<void> {
    const write = this.writes.then(async () => {
      const next = update(this.value)
      await writeJsonFile(this.path, this.serialize(next))
      this.value = next
    })
    this.writes = write.catch(() => {})
    return write
  }
}
