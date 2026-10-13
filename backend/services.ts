import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyRequest } from 'fastify'
import type { Deployment, Owner } from './deployment'
import type { Installations } from './installations'
import type { SessionService, TargetContext } from './sessions'
import type { SoftwareService } from './software'
import type { TerminalBroker } from './terminal/broker'
import type { ConnectTokens } from './terminal/tokens'
import { transportFor } from './transport'

/** Everything a route needs. Routes never branch on the deployment mode. */
export interface Services {
  deployment: Deployment
  sessions: SessionService
  software: SoftwareService
  installations: Installations
  tokens: ConnectTokens
  broker: TerminalBroker
  resolve(owner: Owner, targetId: string): Promise<TargetContext>
  context(request: FastifyRequest, targetId: string): Promise<TargetContext>
}

export function targetResolver(deployment: Deployment, multiplex: boolean) {
  const directory = join(deployment.directory, 'ssh')
  if (multiplex) mkdirSync(directory, { recursive: true, mode: 0o700 })
  return async (owner: Owner, targetId: string): Promise<TargetContext> => {
    const workspace = deployment.workspace(owner)
    const target = await workspace.get(targetId)
    const identity = target.kind === 'ssh' ? await deployment.identity(owner) : null
    return {
      owner,
      target,
      workspace,
      transport: transportFor(target, identity, {
        scope: owner.userId,
        ...(multiplex ? { multiplex: directory } : {}),
      }),
    }
  }
}
