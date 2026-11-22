import {
  desktopSessionId,
  validDesktopId,
  validDesktopSession,
  type DesktopSessionChoice,
  type DesktopAccount,
} from '../../shared/desktopAuth'
import type { SessionInput } from '../../shared/model'
import { harnessIds } from '../../shared/harnesses'
import { softwareIds } from '../../shared/schemas'
import type { SessionCreationOptions } from '../../shared/sessionCreation'
import { parseServerTargets } from './server-targets'
import { ServerApiError } from './server-api'

type Request = (path: string, options?: { signal?: AbortSignal; body?: unknown }) => Promise<unknown>

/** A creation capability bound to one saved login. ServerAccounts rechecks that
 * login before and after every request; the dialog never selects a credential. */
export function sessionCreationServer(summary: { origin: string; account: DesktopAccount }, request: Request) {
  const path = (targetId: string) => {
    if (!validDesktopId(targetId)) throw new Error('Choose a machine.')
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
    async create(targetId: string, input: SessionInput, requestId: string): Promise<DesktopSessionChoice> {
      try {
        const result = await request(`${path(targetId)}/sessions`, { body: { requestId, input } })
        if (!validDesktopSession(result, targetId)) throw new Error('Invalid created session response.')
        const reference = {
          server: summary.origin,
          accountId: summary.account.id,
          targetId,
          sessionId: result.sessionId,
        }
        return {
          ...reference,
          id: desktopSessionId(reference),
          title: result.title,
          detail: result.detail,
          tool: result.tool,
        }
      } catch (error) {
        if (error instanceof ServerApiError && error.status >= 400 && error.status < 500 && error.status !== 408)
          throw error
        throw new Error('Creation could not be confirmed. Try again with the same settings to recover the session.', {
          cause: error,
        })
      }
    },
  }
}
