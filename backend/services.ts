import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyRequest } from 'fastify'
import type { Deployment, Owner } from './deployment'
import type { Installations } from './installations'
import type { ActivityLog } from './logs/activity'
import type { Machines } from './machines'
import type { SessionService, TargetContext } from './sessions'
import type { SessionFileClient } from './sessionFiles'
import type { SoftwareService } from './software'
import type { TerminalBroker } from './terminal/broker'
import type { ConnectTokens } from './terminal/tokens'
import { supportsSshMultiplexing, transportFor } from './transport'

/** Everything a route needs. Routes never branch on the deployment mode. */
export interface Services {
  deployment: Deployment
  sessions: SessionService
  files: SessionFileClient
  software: SoftwareService
  installations: Installations
  tokens: ConnectTokens
  broker: TerminalBroker
  machines: Machines
  log: ActivityLog
  active(owner: Owner): boolean
  resolve(owner: Owner, targetId: string): Promise<TargetContext>
  context(request: FastifyRequest, targetId: string): Promise<TargetContext>
}

export function targetResolver(deployment: Deployment, machines: Machines, multiplex: boolean) {
  const sharing = multiplex && supportsSshMultiplexing()
  const directory = join(deployment.directory, 'ssh')
  if (sharing) mkdirSync(directory, { recursive: true, mode: 0o700 })
  return async (owner: Owner, targetId: string): Promise<TargetContext> => {
    const workspace = deployment.workspace(owner)
    const target = await workspace.get(targetId)
    const identity = target.kind === 'ssh' ? await deployment.identity(owner) : null
    const transport = transportFor(target, identity, {
      scope: owner.userId,
      ...(sharing ? { multiplex: directory } : {}),
    })
    return { owner, target, workspace, transport, machine: machines.get(owner, target.id, transport) }
  }
}
