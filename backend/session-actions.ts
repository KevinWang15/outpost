import { createHmac } from 'node:crypto'
import type { Services } from './services'
import type { Session, SessionInput } from '../shared/model'
import type { DesktopSession } from '../shared/desktopAuth'
import { AppError } from './errors'
import { launchOptions, type TargetContext } from './sessions'

/** Creation is a durable operation with the same policy for browser and app owners. */
export async function createSession(
  services: Services,
  context: TargetContext,
  input: SessionInput,
  requestId?: string,
) {
  const { owner, target } = context
  if (!services.active(owner)) throw new AppError('Sign in again to create a session.', 401)
  if (!context.target.tools.includes(input.tool))
    throw new AppError('Add this coding tool to the target before creating a session.', 400)
  launchOptions(input)
  // Bind the retry identity to the authenticated owner and target. The target
  // commits this receipt atomically with the session, so SSH/HTTP response loss
  // and server restarts cannot turn a retry into another creation.
  const creationKey = requestId
    ? createHmac('sha256', services.deployment.secret)
        .update(JSON.stringify([owner.userId, target.id, requestId]))
        .digest('hex')
    : undefined
  return services.sessions.create(context, input, creationKey)
}

export function desktopSession(session: Session, target: { id: string; name: string }): DesktopSession {
  return {
    sessionId: session.id,
    targetId: target.id,
    title: `${session.name} · ${target.name}`,
    detail: `${session.tool} · ${session.rootDir} · ${session.status}`.slice(0, 4096),
  }
}

export async function inspectTargetSoftware(services: Services, context: TargetContext, signal: AbortSignal) {
  const report = await services.software.inspect(context, signal)
  if (!services.active(context.owner)) throw new AppError('Sign in again to inspect this target.', 401)
  await context.workspace.setEnvironment(context.target.id, report.environment)
  return { ...report, installation: services.installations.latest(context.owner, context.target.id) }
}
