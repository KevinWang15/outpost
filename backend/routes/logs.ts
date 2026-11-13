import type { FastifyInstance } from 'fastify'
import Type from 'typebox'
import { webhookInput, type LogEvent, type WebhookInput } from '../../shared/logs'
import type { Services } from '../services'

type Params = { webhookId: string }
const params = Type.Object({ webhookId: Type.String({ format: 'uuid' }) })

export function logRoutes(app: FastifyInstance, services: Services) {
  const { deployment, log } = services
  app.get('/api/logs', async request => log.view(deployment.owner(request)))
  app.get('/api/webhooks', async request => log.webhooks.list(deployment.owner(request)))
  app.post<{ Body: WebhookInput }>('/api/webhooks', { schema: { body: webhookInput } }, async (request, reply) => {
    const owner = deployment.owner(request)
    const webhook = await log.webhooks.create(owner, request.body)
    log.record(owner, {
      kind: 'webhook',
      type: 'created',
      message: `Webhook ${webhook.name} was created`,
      details: { webhook: webhook.name },
    })
    return reply.code(201).send(webhook)
  })
  app.put<{ Params: Params; Body: WebhookInput }>(
    '/api/webhooks/:webhookId',
    { schema: { params, body: webhookInput } },
    async request => {
      const owner = deployment.owner(request)
      const webhook = await log.webhooks.update(owner, request.params.webhookId, request.body)
      log.record(owner, {
        kind: 'webhook',
        type: 'edited',
        message: `Webhook ${webhook.name} was ${webhook.enabled ? 'edited' : 'edited and is paused'}`,
        details: { webhook: webhook.name },
      })
      return webhook
    },
  )
  app.delete<{ Params: Params }>('/api/webhooks/:webhookId', { schema: { params } }, async (request, reply) => {
    await log.webhooks.remove(deployment.owner(request), request.params.webhookId)
    return reply.code(204).send()
  })
  // A sample event, sent once, so the receiver can be checked from the dialog.
  app.post<{ Params: Params }>('/api/webhooks/:webhookId/test', { schema: { params } }, async request => {
    const event: LogEvent = {
      id: crypto.randomUUID(),
      time: new Date().toISOString(),
      level: 'info',
      kind: 'webhook',
      type: 'test',
      message: 'A test event from Outpost',
      machine: null,
      session: null,
      details: {},
    }
    return log.webhooks.test(deployment.owner(request), request.params.webhookId, event)
  })
}
