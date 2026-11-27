import { validDesktopCredential, type DesktopCredential } from '../../shared/desktopAuth'
import { serverOrigin } from '../../shared/serverOrigin'
import { SerializedJsonStore } from './json-store'

export interface SavedServerLogin extends DesktopCredential {
  origin: string
}

/** Serialized, atomic credential persistence. Publish in memory only after disk commit. */
export class ServerLoginStore {
  private store: SerializedJsonStore<Map<string, SavedServerLogin>>

  constructor(path: string) {
    this.store = new SerializedJsonStore(path, new Map<string, SavedServerLogin>(), records => [...records.values()])
  }

  list() {
    return [...this.store.value.values()]
  }

  get(origin: string) {
    return this.store.value.get(origin)
  }

  load(allowed: (origin: string) => boolean) {
    return this.store.load(raw => {
      if (!Array.isArray(raw)) throw new Error('Invalid app server login file.')
      const records = new Map<string, SavedServerLogin>()
      for (const entry of raw) {
        if (!validDesktopCredential(entry) || !('origin' in entry) || typeof entry.origin !== 'string') continue
        try {
          const origin = serverOrigin(entry.origin)
          if (allowed(origin))
            records.set(origin, {
              origin,
              token: entry.token,
              expiresAt: entry.expiresAt,
              account: { id: entry.account.id, name: entry.account.name, email: entry.account.email },
            })
        } catch {
          // Ignore malformed origins without loading a credential for them.
        }
      }
      return records
    }, 'Could not read app server logins.')
  }

  put(entry: SavedServerLogin) {
    return this.store.change(records => new Map(records).set(entry.origin, entry))
  }

  remove(entry: SavedServerLogin) {
    return this.store.change(records => {
      const next = new Map(records)
      if (next.get(entry.origin) === entry) next.delete(entry.origin)
      return next
    })
  }
}
