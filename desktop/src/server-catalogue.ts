import { desktopSessionId, validDesktopId, type DesktopSessionChoice } from '../../shared/desktopAuth'
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
const text = (value: unknown, limit = 512): value is string => typeof value === 'string' && value.length <= limit

/** Bounded discovery across independent servers. Only current account results
 * are published, and one target's failure does not hide other sessions. */
export async function loadSessionCatalogue(
  servers: CatalogueServer[],
  signal: AbortSignal,
  publish: (catalogue: SessionCatalogue) => void,
) {
  const queue = requestQueue(4, signal)
  const found = new Map<CatalogueServer, DesktopSessionChoice[]>()
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
        const sessions: DesktopSessionChoice[] = []
        found.set(server, sessions)
        await Promise.all(
          targets.map(async target => {
            try {
              const result = await queue(() =>
                server.request(`/targets/${encodeURIComponent(target.id)}/sessions`, signal),
              )
              if (
                !Array.isArray(result) ||
                result.length > 10_000 ||
                !result.every(
                  item =>
                    item &&
                    validDesktopId(item.sessionId) &&
                    item.targetId === target.id &&
                    text(item.title) &&
                    text(item.detail, 4096),
                )
              )
                throw new Error('Invalid server session list.')
              if (!server.current() || signal.aborted) return
              for (const item of result) {
                const reference = {
                  server: server.origin,
                  accountId: server.accountId,
                  targetId: target.id,
                  sessionId: item.sessionId,
                }
                sessions.push({ ...reference, id: desktopSessionId(reference), title: item.title, detail: item.detail })
              }
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
