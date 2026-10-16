import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { desktopOrigin } from '../../shared/desktop'

export interface RecentSessionSummary {
  id: string
  server: string
  title: string
  lastConnectedAt: number
}
export interface RecentSession extends RecentSessionSummary {
  sessionKey: string
  token: string
}

/** Shared with the open-tab registry; this routing identity is not authorization. */
export const remoteSessionId = (server: string, sessionKey: string) => JSON.stringify([server, sessionKey])
export const validResumeToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 8192 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)

/** Ten remote sessions, with plain reconnect credentials in the app's userData directory. */
export class RecentSessions {
  private entries: RecentSession[] = []
  private writes = Promise.resolve()
  constructor(private path: string) {}

  async load() {
    try {
      const data: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!Array.isArray(data)) throw new Error('Invalid recent sessions.')
      const entries = new Map<string, RecentSession>()
      for (const item of data) {
        if (!item || typeof item !== 'object') continue
        const { server, sessionKey, token, title, lastConnectedAt } = item
        if (
          typeof server !== 'string' ||
          typeof sessionKey !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(sessionKey) ||
          !validResumeToken(token) ||
          typeof title !== 'string' ||
          title.length > 512 ||
          typeof lastConnectedAt !== 'number' ||
          !Number.isFinite(lastConnectedAt) ||
          lastConnectedAt < 0
        )
          continue
        try {
          const origin = desktopOrigin(server)
          const id = remoteSessionId(origin, sessionKey)
          if ((entries.get(id)?.lastConnectedAt ?? -1) <= lastConnectedAt)
            entries.set(id, { id, server: origin, sessionKey, token, title, lastConnectedAt })
        } catch {
          // Ignore invalid origins without granting trust from this file.
        }
      }
      this.entries = [...entries.values()].sort((a, b) => b.lastConnectedAt - a.lastConnectedAt).slice(0, 10)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Could not read recent sessions.', { cause: error })
    }
  }

  /** Credentials never enter a workspace snapshot. */
  list(): RecentSessionSummary[] {
    return this.entries.map(({ id, server, title, lastConnectedAt }) => ({ id, server, title, lastConnectedAt }))
  }
  get(id: string) {
    return this.entries.find(entry => entry.id === id)
  }
  remember(entry: RecentSession) {
    return this.change(entries => [entry, ...entries.filter(item => item.id !== entry.id)].slice(0, 10))
  }
  remove(id: string) {
    return this.change(entries => entries.filter(entry => entry.id !== id))
  }
  clear() {
    return this.change(() => [])
  }
  retainServers(allowed: (server: string) => boolean) {
    return this.change(entries => entries.filter(entry => allowed(entry.server)))
  }
  flush() {
    return this.writes
  }
  private change(update: (entries: RecentSession[]) => RecentSession[]) {
    const write = this.writes.then(async () => {
      const next = update(this.entries)
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      await writeFile(this.path + '.tmp', JSON.stringify(next), { mode: 0o600 })
      await rename(this.path + '.tmp', this.path)
      this.entries = next
    })
    this.writes = write.catch(() => {})
    return write
  }
}
