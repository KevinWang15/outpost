import { randomUUID } from 'node:crypto'
import { Ajv } from 'ajv'
import type { FastifyInstance } from 'fastify'
import type { Environment, InstallationInput, Target, TargetInput, TargetUpdate } from '../../shared/model'
import { machineSetupLabels } from '../../shared/model'
import { AppError } from '../errors'
import { withRequestSignal } from '../request'
import type { Services } from '../services'
import { installationInput, targetInput, targetUpdate } from '../../shared/schemas'
import { inspectTargetSoftware } from '../session-actions'

const ajv = new Ajv({ allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: false })
const validInstallationInput = ajv.compile<InstallationInput>(installationInput)
type Params = { targetId: string }

export function workspaceRoutes(
  app: FastifyInstance,
  services: Services,
  forgetEnrollment: (targetId: string) => void,
) {
  const { deployment, installations, log } = services
  app.get('/api/environment', async request => {
    const owner = deployment.owner(request)
    return {
      mode: deployment.mode,
      localTargets:
        deployment.localTargets &&
        !(await deployment.workspace(owner).list()).some(machine => machine.kind === 'local'),
    } satisfies Environment
  })
  app.get('/api/targets', async request => deployment.workspace(deployment.owner(request)).list())
  app.post<{ Body: TargetInput }>('/api/targets', { schema: { body: targetInput } }, async (request, reply) => {
    const owner = deployment.owner(request)
    const target: Target = {
      ...request.body,
      name: request.body.name.trim(),
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    }
    const added = await deployment.workspace(owner).add(target)
    log.record(owner, {
      kind: 'machine',
      type: 'added',
      message: `${added.name} was added`,
      machine: { id: added.id, name: added.name },
      details: {
        address: added.kind === 'ssh' ? `${added.user}@${added.host}` : machineSetupLabels[added.kind],
      },
    })
    if (added.kind === 'ssh') await installations.start(await services.resolve(owner, added.id))
    return reply.code(201).send(added)
  })
  app.patch<{ Params: Params; Body: TargetUpdate }>(
    '/api/targets/:targetId',
    { schema: { body: targetUpdate } },
    async request => {
      const { owner, workspace, target } = await services.context(request, request.params.targetId)
      const edited = await workspace.edit(target.id, { name: request.body.name.trim() })
      log.record(owner, {
        kind: 'machine',
        type: 'edited',
        message: `${edited.name} was edited`,
        machine: { id: edited.id, name: edited.name },
      })
      return edited
    },
  )
  app.delete<{ Params: Params }>('/api/targets/:targetId', async (request, reply) => {
    const { owner, workspace, target } = await services.context(request, request.params.targetId)
    await installations.removeTarget(owner, target.id, () => workspace.remove(target.id))
    if (target.kind === 'outbound') forgetEnrollment(target.id)
    services.broker.closeTarget(owner, target.id)
    services.machines.forget(owner, target.id)
    log.record(owner, {
      kind: 'machine',
      type: 'removed',
      message: `${target.name} was removed`,
      machine: { id: target.id, name: target.name },
    })
    return reply.code(204).send()
  })
  app.get<{ Params: Params }>('/api/targets/:targetId/software', async (request, reply) =>
    withRequestSignal(reply, async signal => {
      const context = await services.context(request, request.params.targetId)
      return inspectTargetSoftware(services, context, signal)
    }),
  )
  app.post<{ Params: Params; Body: InstallationInput | undefined }>(
    '/api/targets/:targetId/installations',
    async (request, reply) => {
      if (request.body !== undefined && !validInstallationInput(request.body))
        throw new AppError('Invalid software installation request.', 400)
      const context = await services.context(request, request.params.targetId)
      return reply.code(202).send(await installations.start(context, request.body?.software))
    },
  )
  app.get<{ Params: Params }>('/api/targets/:targetId/installations', async request => {
    const { owner, target } = await services.context(request, request.params.targetId)
    return { installation: installations.latest(owner, target.id) }
  })
  app.get<{ Params: Params & { installationId: string } }>(
    '/api/targets/:targetId/installations/:installationId/events',
    async (request, reply) => {
      const { owner, target } = await services.context(request, request.params.targetId)
      reply.header('X-Accel-Buffering', 'no')
      return reply
        .type('application/x-ndjson; charset=utf-8')
        .send(installations.events(owner, target.id, request.params.installationId))
    },
  )
}
