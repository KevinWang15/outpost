import { validDesktopId, desktopSessionId, type DesktopSessionReference } from '../../shared/desktopAuth'
import { serverOrigin } from '../../shared/serverOrigin'
import { isHarnessId, type HarnessId } from '../../shared/harnesses'
import { SerializedJsonStore } from './json-store'

export interface RecentSessionSummary {
  id: string
  server: string
  title: string
  tool: HarnessId
  lastConnectedAt: number
}
export interface RecentSession extends RecentSessionSummary, DesktopSessionReference {}

/** Ten remote sessions, with session references in the app's data directory. */
export class RecentSessions {
  private store: SerializedJsonStore<RecentSession[]>

  constructor(path: string) {
    this.store = new SerializedJsonStore<RecentSession[]>(path, [])
  }

  load() {
    return this.store.load(data => {
      if (!Array.isArray(data)) throw new Error('Invalid recent sessions.')
      const entries = new Map<string, RecentSession>()
      for (const item of data) {
        if (!item || typeof item !== 'object') continue
        const { server, accountId, targetId, sessionId, title, tool, lastConnectedAt } = item
        if (
          typeof server !== 'string' ||
          !validDesktopId(accountId) ||
          !validDesktopId(targetId) ||
          !validDesktopId(sessionId) ||
          typeof title !== 'string' ||
          title.length > 512 ||
          !isHarnessId(tool) ||
          typeof lastConnectedAt !== 'number' ||
          !Number.isFinite(lastConnectedAt) ||
          lastConnectedAt < 0
        )
          continue
        try {
          const origin = serverOrigin(server)
          const id = desktopSessionId({ server: origin, accountId, targetId, sessionId })
          if ((entries.get(id)?.lastConnectedAt ?? -1) <= lastConnectedAt)
            entries.set(id, { id, server: origin, accountId, targetId, sessionId, title, tool, lastConnectedAt })
        } catch {
          // Ignore invalid origins without granting trust from this file.
        }
      }
      return [...entries.values()].sort((a, b) => b.lastConnectedAt - a.lastConnectedAt).slice(0, 10)
    }, 'Could not read recent sessions.')
  }

  /** The home view needs labels only; connection references stay in the helper process. */
  list(allowed: (session: RecentSession) => boolean): RecentSessionSummary[] {
    return this.store.value.filter(allowed).map(({ id, server, title, tool, lastConnectedAt }) => ({
      id,
      server,
      title,
      tool,
      lastConnectedAt,
    }))
  }

  get(id: string) {
    return this.store.value.find(entry => entry.id === id)
  }

  remember(entry: RecentSession) {
    return this.store.change(entries => [entry, ...entries.filter(item => item.id !== entry.id)].slice(0, 10))
  }

  clear() {
    return this.store.change(() => [])
  }

  retain(allowed: (session: RecentSession) => boolean) {
    return this.store.change(entries => entries.filter(allowed))
  }
}
