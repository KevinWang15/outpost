import type { Owner } from './deployment'
import type { Services } from './services'
import type { SessionInput } from '../shared/model'
import { AppError } from './errors'
import { launchOptions, type TargetContext } from './sessions'

/** Creation is a durable operation with the same policy for browser and app owners. */
export async function createSession(services: Services, owner: Owner, targetId: string, input: SessionInput) {
  const context = await services.resolve(owner, targetId)
  if (!services.active(owner)) throw new AppError('Sign in again to create a session.', 401)
  if (!context.target.tools.includes(input.tool))
    throw new AppError('Add this coding tool to the target before creating a session.', 400)
  launchOptions(input)
  return services.sessions.create(context, input)
}

export async function inspectTargetSoftware(services: Services, context: TargetContext, signal: AbortSignal) {
  const report = await services.software.inspect(context, signal)
  if (!services.active(context.owner)) throw new AppError('Sign in again to inspect this target.', 401)
  await context.workspace.setEnvironment(context.target.id, report.environment)
  return { ...report, installation: services.installations.latest(context.owner, context.target.id) }
}
