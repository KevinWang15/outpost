import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { desktopOrigin, validDesktopCredential, type DesktopCredential } from '../../shared/desktopAuth'

export interface SavedServerLogin extends DesktopCredential {
  origin: string
}

/** Serialized, atomic credential persistence. Publish in memory only after disk commit. */
export class ServerLoginStore {
  private records = new Map<string, SavedServerLogin>()
  private writes = Promise.resolve()
  constructor(private path: string) {}
  list() {
    return [...this.records.values()]
  }
  get(origin: string) {
    return this.records.get(origin)
  }
  async load(allowed: (origin: string) => boolean) {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(this.path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error('Could not read app server logins.', { cause: error })
    }
    if (!Array.isArray(raw)) throw new Error('Invalid app server login file.')
    for (const entry of raw) {
      if (!validDesktopCredential(entry) || !('origin' in entry) || typeof entry.origin !== 'string') continue
      const origin = desktopOrigin(entry.origin)
      if (allowed(origin))
        this.records.set(origin, {
          origin,
          token: entry.token,
          expiresAt: entry.expiresAt,
          account: { id: entry.account.id, name: entry.account.name, email: entry.account.email },
        })
    }
  }
  put(entry: SavedServerLogin) {
    return this.change(records => {
      records.set(entry.origin, entry)
    })
  }
  remove(entry: SavedServerLogin) {
    return this.change(records => {
      if (records.get(entry.origin) === entry) records.delete(entry.origin)
    })
  }
  flush() {
    return this.writes
  }
  private change(update: (records: Map<string, SavedServerLogin>) => void) {
    const work = this.writes.then(async () => {
      const next = new Map(this.records)
      update(next)
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      await writeFile(this.path + '.tmp', JSON.stringify([...next.values()]), { mode: 0o600 })
      await rename(this.path + '.tmp', this.path)
      this.records = next
    })
    this.writes = work.catch(() => {})
    return work
  }
}
