import { desktopSessionId, validDesktopSession, type DesktopSessionChoice } from '../../shared/desktopAuth'
import { requestQueue } from './server-api'
import { parseServerTargets } from './server-targets'

interface CatalogueServer {
  origin: string
  accountId: string
  current(): boolean
  request(path: string, signal: AbortSignal): Promise<unknown>
}
export interface SessionCatalogue {
  sessions: DesktopSessionChoice[]
  errors: string[]
}

/** Bounded discovery across independent servers. Only current account results
 * are published, and one target's failure does not hide other sessions. */
export async function loadSessionCatalogue(
  servers: CatalogueServer[],
  signal: AbortSignal,
  publish: (catalogue: SessionCatalogue) => void,
  previous: DesktopSessionChoice[] = [],
) {
  const queue = requestQueue(4, signal)
  const found = new Map(
    servers.map(server => [
      server,
      previous.filter(item => item.server === server.origin && item.accountId === server.accountId),
    ]),
  )
  const errors: string[] = []
  const update = () => {
    if (!signal.aborted)
      publish({
        sessions: [...found].flatMap(([server, sessions]) => (server.current() ? sessions : [])),
        errors: [...errors],
      })
  }
  const failed = (server: CatalogueServer, error: unknown, target?: string) => {
    if (signal.aborted) return
    errors.push(
      `${server.origin}${target ? ' · ' + target : ''}: ${error instanceof Error ? error.message : 'Could not load sessions.'}`,
    )
    update()
  }
  await Promise.all(
    servers.map(async server => {
      try {
        const targets = parseServerTargets(await queue(() => server.request('/targets', signal)))
        if (!server.current() || signal.aborted) return
        // Keep prior rows only for targets that failed to refresh. A successful
        // response replaces its own scope, including deletions and empty lists.
        const targetIds = new Set(targets.map(target => target.id))
        found.set(
          server,
          found.get(server)!.filter(session => targetIds.has(session.targetId)),
        )
        update()
        await Promise.all(
          targets.map(async target => {
            try {
              const result = await queue(() =>
                server.request(`/targets/${encodeURIComponent(target.id)}/sessions`, signal),
              )
              if (
                !Array.isArray(result) ||
                result.length > 10_000 ||
                !result.every(item => validDesktopSession(item, target.id))
              )
                throw new Error('Invalid server session list.')
              if (!server.current() || signal.aborted) return
              const sessions = found.get(server)!.filter(session => session.targetId !== target.id)
              for (const item of result) {
                const reference = {
                  server: server.origin,
                  accountId: server.accountId,
                  targetId: target.id,
                  sessionId: item.sessionId,
                }
                sessions.push({ ...reference, id: desktopSessionId(reference), title: item.title, detail: item.detail })
              }
              found.set(server, sessions)
              update()
            } catch (error) {
              failed(server, error, target.name)
            }
          }),
        )
      } catch (error) {
        failed(server, error)
      }
    }),
  )
  update()
}
