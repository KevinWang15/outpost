import { createHmac } from 'node:crypto'
import type { Services } from './services'
import type { SessionForkInput, SessionInput } from '../shared/model'
import { machineEndpoint } from '../shared/model'
import { machineAuthority } from './paired'
import { AppError } from './errors'
import { launchSize, type TargetContext } from './sessions'

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
    throw new AppError('Add this coding tool to the machine before creating a session.', 400)
  launchSize(input)
  return services.sessions.create(context, input, sessionCreationKey(services, owner.userId, target.id, requestId))
}

// The machine commits this identity with the session, across retries and routes.
export function sessionCreationKey(services: Services, userId: string, targetId: string, requestId?: string) {
  return requestId
    ? createHmac('sha256', services.deployment.secret)
        .update(JSON.stringify([userId, targetId, requestId]))
        .digest('hex')
    : undefined
}

// The enrolled machine checks the session when a client attaches directly.
// Server-managed launches can resolve its name through their existing connection.
export async function terminalLaunch(
  services: Services,
  context: TargetContext,
  sessionId: string,
  signal: AbortSignal,
) {
  const { owner, target } = context
  let title = target.name
  if (machineEndpoint(target)) {
    if (!/^[\w-]{1,128}$/.test(sessionId)) throw new AppError('Invalid session.', 400)
    if (!machineAuthority(services.deployment, owner, target))
      throw new AppError('Enroll this machine before connecting.', 409)
  } else {
    const session = await services.sessions.get(context, sessionId, signal)
    title = `${session.name} · ${target.name}`
  }
  if (!services.active(owner)) throw new AppError('Sign in again to connect.', 401)
  return { launch: services.tokens.issue({ owner, targetId: target.id, sessionId }), title }
}

/** A new session on a new Git branch and worktree, with the source's tool and launch settings. */
export async function forkSession(services: Services, context: TargetContext, id: string, input: SessionForkInput) {
  const source = await services.sessions.get(context, id)
  if (!context.target.tools.includes(source.tool))
    throw new AppError('Add this coding tool to the machine before creating a session.', 400)
  return services.sessions.fork(context, source.id, input)
}

export { desktopSession } from '../shared/desktopSession'

export async function inspectTargetSoftware(services: Services, context: TargetContext, signal: AbortSignal) {
  const report = await services.software.inspect(context, signal)
  if (!services.active(context.owner)) throw new AppError('Sign in again to inspect this machine.', 401)
  await context.workspace.setEnvironment(context.target.id, report.environment)
  return { ...report, installation: services.installations.latest(context.owner, context.target.id) }
}
