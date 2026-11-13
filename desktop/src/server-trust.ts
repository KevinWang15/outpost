import { readFile } from 'node:fs/promises'
import { desktopOrigin } from '../../shared/desktopAuth'
import { writeJsonFile } from '../../shared/node/jsonFile'

/** Persistent first-use trust, separate from app logins and terminal grants. */
export class ServerTrust {
  private servers = new Set<string>()
  private writes = Promise.resolve()
  private prompts = new Map<string, Promise<boolean>>()
  constructor(
    private path: string,
    private prompt: (origin: string) => Promise<boolean>,
  ) {}
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
  has(origin: string) {
    return this.servers.has(origin)
  }
  ensure(value: string) {
    const origin = desktopOrigin(value)
    if (this.has(origin)) return Promise.resolve(true)
    const pending = this.prompts.get(origin)
    if (pending) return pending
    const work = this.prompt(origin)
      .then(async accepted => {
        if (accepted) await this.remember(origin)
        return accepted
      })
      .finally(() => this.prompts.delete(origin))
    this.prompts.set(origin, work)
    return work
  }
  private remember(origin: string) {
    const write = this.writes.then(async () => {
      const next = new Set(this.servers)
      next.add(desktopOrigin(origin))
      await writeJsonFile(this.path, [...next])
      this.servers = next
    })
    this.writes = write.catch(() => {})
    return write
  }
}
