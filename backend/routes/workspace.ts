import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Environment, SoftwareId, Target, TargetInput, TargetUpdate } from '../../shared/model'
import { requiredSoftware } from '../../shared/model'
import { AppError } from '../errors'
import { withRequestSignal } from '../request'
import type { Services } from '../services'
import { planInstallation } from '../software'
import { installationInput, targetInput, targetUpdate } from '../../shared/schemas'

type Params = { targetId: string }

export function workspaceRoutes(app: FastifyInstance, services: Services) {
  const { deployment, software, installations } = services
  app.get('/api/environment', async request => {
    deployment.owner(request)
    return { mode: deployment.mode, localTargets: deployment.localTargets } satisfies Environment
  })
  app.get('/api/targets', async request => deployment.workspace(deployment.owner(request)).list())
  app.post<{ Body: TargetInput }>('/api/targets', { schema: { body: targetInput } }, async (request, reply) => {
    const owner = deployment.owner(request)
    deployment.validateTarget(request.body)
    const target: Target = { ...request.body, name: request.body.name.trim(), id: randomUUID(), createdAt: new Date().toISOString() }
    return reply.code(201).send(await deployment.workspace(owner).add(target))
  })
  app.patch<{ Params: Params; Body: TargetUpdate }>('/api/targets/:targetId', { schema: { body: targetUpdate } }, async request => {
    const { workspace, target } = await services.context(request, request.params.targetId)
    return workspace.edit(target.id, { ...request.body, ...(request.body.name ? { name: request.body.name.trim() } : {}) })
  })
  app.delete<{ Params: Params }>('/api/targets/:targetId', async (request, reply) => {
    const { owner, workspace, target } = await services.context(request, request.params.targetId)
    await installations.removeTarget(owner, target.id, () => workspace.remove(target.id))
    services.broker.closeTarget(owner, target.id)
    return reply.code(204).send()
  })
  app.get<{ Params: Params }>('/api/targets/:targetId/software', async (request, reply) => withRequestSignal(reply, async signal => {
    const context = await services.context(request, request.params.targetId)
    const report = await software.inspect(context, signal)
    await context.workspace.setEnvironment(context.target.id, report.environment)
    return { ...report, installation: installations.latest(context.owner, context.target.id) }
  }))
  app.get<{ Params: Params & { softwareId: SoftwareId } }>('/api/targets/:targetId/software/:softwareId/script', async request => {
    const { target } = await services.context(request, request.params.targetId)
    if (!requiredSoftware(target).includes(request.params.softwareId)) throw new AppError('Software is not required by this target', 400)
    return planInstallation(request.params.softwareId)
  })
  app.post<{ Params: Params; Body: { softwareId: SoftwareId; script: string } }>('/api/targets/:targetId/installations', {
    schema: { body: installationInput },
  }, async (request, reply) => {
    const context = await services.context(request, request.params.targetId)
    return reply.code(202).send(await installations.start(context, request.body.softwareId, request.body.script))
  })
  app.get<{ Params: Params }>('/api/targets/:targetId/installations', async request => {
    const { owner, target } = await services.context(request, request.params.targetId)
    return { installation: installations.latest(owner, target.id) }
  })
  app.get<{ Params: Params & { installationId: string } }>('/api/targets/:targetId/installations/:installationId/events', async (request, reply) => {
    const { owner, target } = await services.context(request, request.params.targetId)
    reply.header('X-Accel-Buffering', 'no')
    return reply.type('application/x-ndjson; charset=utf-8').send(installations.events(owner, target.id, request.params.installationId))
  })
}
