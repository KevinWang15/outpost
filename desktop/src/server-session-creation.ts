import { validDesktopId, type DesktopSessionReference } from '../../shared/desktopAuth'
import type { DirectorySuggestions, SessionInput } from '../../shared/model'
import { harnessIds } from '../../shared/harnesses'
import { softwareIds } from '../../shared/schemas'
import type { SessionCreationOptions } from '../../shared/sessionCreation'
import type { SessionCreatorServerSummary } from '../../shared/sessionCreator'
import { parseServerTargets } from './server-targets'

type Request = (path: string, options?: { signal?: AbortSignal; body?: unknown }) => Promise<unknown>
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit

/** A creation capability bound to one saved login. ServerAccounts rechecks that
 * login before and after every request; the dialog never selects a credential. */
export function sessionCreationServer(summary: SessionCreatorServerSummary, request: Request) {
  const path = (targetId: string) => {
    if (!validDesktopId(targetId)) throw new Error('Choose an execution target.')
    return `/targets/${encodeURIComponent(targetId)}`
  }
  return {
    summary,
    async targets(signal: AbortSignal) {
      return parseServerTargets(await request('/targets', { signal }))
    },
    async options(targetId: string, signal: AbortSignal): Promise<SessionCreationOptions> {
      const result = (await request(`${path(targetId)}/session-options`, { signal })) as SessionCreationOptions
      if (
        !result ||
        !Array.isArray(result.tools) ||
        !Array.isArray(result.missing) ||
        result.tools.length > harnessIds.length ||
        !result.tools.every(tool => harnessIds.includes(tool)) ||
        result.missing.length > softwareIds.length ||
        !result.missing.every(id => softwareIds.includes(id))
      )
        throw new Error('Invalid session creation options.')
      return { tools: result.tools, missing: result.missing }
    },
    async directories(targetId: string, value: string, signal: AbortSignal): Promise<DirectorySuggestions> {
      const result = (await request(`${path(targetId)}/directories?path=${encodeURIComponent(value)}`, {
        signal,
      })) as DirectorySuggestions
      if (
        !result ||
        !Array.isArray(result.directories) ||
        result.directories.length > 50 ||
        !result.directories.every(item => text(item, 4096)) ||
        typeof result.truncated !== 'boolean'
      )
        throw new Error('Invalid directory suggestions.')
      return { directories: result.directories, truncated: result.truncated }
    },
    async create(targetId: string, input: SessionInput): Promise<DesktopSessionReference> {
      const result = (await request(`${path(targetId)}/sessions`, { body: input })) as { sessionId?: unknown }
      if (!result || !validDesktopId(result.sessionId)) throw new Error('Invalid created session response.')
      return { server: summary.origin, accountId: summary.account.id, targetId, sessionId: result.sessionId }
    },
  }
}
export type SessionCreationServer = ReturnType<typeof sessionCreationServer>
