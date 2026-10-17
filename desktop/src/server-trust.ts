import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { desktopOrigin } from '../../shared/desktopAuth'

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
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      await writeFile(this.path + '.tmp', JSON.stringify([...next]), { mode: 0o600 })
      await rename(this.path + '.tmp', this.path)
      this.servers = next
    })
    this.writes = write.catch(() => {})
    return write
  }
}
