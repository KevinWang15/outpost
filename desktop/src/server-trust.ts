import { serverOrigin } from '../../shared/serverOrigin'
import { SerializedJsonStore } from './json-store'

/** Persistent first-use trust, separate from app logins and terminal grants. */
export class ServerTrust {
  private store: SerializedJsonStore<Set<string>>
  private prompts = new Map<string, Promise<boolean>>()

  constructor(
    path: string,
    private prompt: (origin: string) => Promise<boolean>,
  ) {
    this.store = new SerializedJsonStore(path, new Set<string>(), servers => [...servers])
  }

  load() {
    return this.store.load(data => {
      if (!Array.isArray(data)) throw new Error('Invalid server preferences.')
      const servers = new Set<string>()
      for (const origin of data) {
        if (typeof origin !== 'string') continue
        try {
          servers.add(serverOrigin(origin))
        } catch {
          /* Ignore invalid entries. */
        }
      }
      return servers
    }, 'Could not read trusted server preferences.')
  }

  has(origin: string) {
    return this.store.value.has(origin)
  }

  ensure(value: string) {
    const origin = serverOrigin(value)
    if (this.has(origin)) return Promise.resolve(true)
    const pending = this.prompts.get(origin)
    if (pending) return pending
    const work = this.prompt(origin)
      .then(async accepted => {
        if (accepted) await this.setTrusted(origin, true)
        return accepted
      })
      .finally(() => this.prompts.delete(origin))
    this.prompts.set(origin, work)
    return work
  }

  forget(origin: string) {
    return this.setTrusted(origin, false)
  }

  private setTrusted(origin: string, trusted: boolean) {
    return this.store.change(servers => {
      const next = new Set(servers)
      if (trusted) next.add(origin)
      else next.delete(origin)
      return next
    })
  }
}
