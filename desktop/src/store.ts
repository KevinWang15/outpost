import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { desktopOrigin } from '../../shared/desktop'

/** Explicit server trust only; reconnect credentials live separately in recent-sessions.json. */
export class TrustedServers {
  private servers = new Set<string>()
  private writes = Promise.resolve()
  constructor(private path: string) {}
  async load() {
    try {
      const data: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!Array.isArray(data)) throw new Error('Invalid server preferences.')
      for (const origin of data) {
        if (typeof origin !== 'string') continue
        try {
          this.servers.add(desktopOrigin(origin))
        } catch {
          /* Ignore invalid entries. */
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Could not read trusted server preferences.', { cause: error })
    }
  }
  list() {
    return [...this.servers]
  }
  has(origin: string) {
    return this.servers.has(origin)
  }
  set(origin: string, trusted: boolean) {
    const write = this.writes.then(async () => {
      const next = new Set(this.servers)
      if (trusted) next.add(origin)
      else next.delete(origin)
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      await writeFile(this.path + '.tmp', JSON.stringify([...next]), { mode: 0o600 })
      await rename(this.path + '.tmp', this.path)
      this.servers = next
    })
    this.writes = write.catch(() => {})
    return write
  }
}
