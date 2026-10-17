import type { FastifyInstance } from 'fastify'
import type { ConversationSearch, SessionForkInput, SessionInput } from '../../shared/model'
import { AppError } from '../errors'
import { withRequestSignal } from '../request'
import type { Services } from '../services'
import { createSession } from '../session-actions'
import {
  acknowledgeInput,
  conversationSearch,
  directoryQuery,
  sessionInput,
  sessionForkInput,
} from '../../shared/schemas'

type Params = { targetId: string; sessionId: string }
export function sessionRoutes(app: FastifyInstance, services: Services) {
  const { sessions, broker, tokens } = services
  const base = '/api/targets/:targetId/sessions'
  app.get<{ Params: Params }>(base, async (request, reply) =>
    withRequestSignal(reply, async signal =>
      sessions.list(await services.context(request, request.params.targetId), signal),
    ),
  )
  app.post<{ Params: Params; Body: SessionInput }>(base, { schema: { body: sessionInput } }, async (request, reply) => {
    const owner = services.deployment.owner(request)
    return reply.code(201).send(await createSession(services, owner, request.params.targetId, request.body))
  })
  app.get<{ Params: Params }>(`${base}/:sessionId`, async (request, reply) =>
    withRequestSignal(reply, async signal =>
      sessions.get(await services.context(request, request.params.targetId), request.params.sessionId, signal),
    ),
  )
  app.post<{ Params: Params; Body: SessionForkInput }>(
    `${base}/:sessionId/fork`,
    { schema: { body: sessionForkInput } },
    async (request, reply) => {
      const context = await services.context(request, request.params.targetId)
      const source = await sessions.get(context, request.params.sessionId)
      if (!context.target.tools.includes(source.tool))
        throw new AppError('Add this coding tool to the target before creating a session.', 400)
      return reply.code(201).send(await sessions.fork(context, source.id, request.body))
    },
  )
  app.delete<{ Params: Params }>(`${base}/:sessionId`, async (request, reply) => {
    const context = await services.context(request, request.params.targetId)
    await sessions.remove(context, request.params.sessionId)
    broker.closeTarget(context.owner, context.target.id, request.params.sessionId)
    return reply.code(204).send()
  })
  app.post<{ Params: Params }>(`${base}/:sessionId/terminate`, async request => {
    const context = await services.context(request, request.params.targetId)
    const session = await sessions.terminate(context, request.params.sessionId)
    broker.closeTarget(context.owner, context.target.id, request.params.sessionId)
    return session
  })
  app.post<{ Params: Params; Body: { completionId: string } }>(
    `${base}/:sessionId/acknowledge`,
    {
      schema: { body: acknowledgeInput },
    },
    async request =>
      sessions.acknowledge(
        await services.context(request, request.params.targetId),
        request.params.sessionId,
        request.body.completionId,
      ),
  )
  app.post<{ Params: Params }>(
    `${base}/:sessionId/connect`,
    {
      schema: { body: { type: 'object', additionalProperties: false } },
    },
    async (request, reply) =>
      withRequestSignal(reply, async signal => {
        const context = await services.context(request, request.params.targetId)
        const session = await sessions.get(context, request.params.sessionId, signal)
        if (!services.active(context.owner)) throw new AppError('Sign in again to connect.', 401)
        return tokens.issue({ owner: context.owner, targetId: context.target.id, sessionId: session.id })
      }),
  )
  app.post<{ Params: Params; Body: ConversationSearch }>(
    '/api/targets/:targetId/conversations/search',
    {
      schema: { body: conversationSearch },
    },
    async (request, reply) =>
      withRequestSignal(reply, async signal =>
        sessions.search(await services.context(request, request.params.targetId), request.body, signal),
      ),
  )
  app.get<{ Params: Params; Querystring: { path: string } }>(
    '/api/targets/:targetId/directories',
    {
      schema: { querystring: directoryQuery },
    },
    async (request, reply) =>
      withRequestSignal(reply, async signal =>
        sessions.directories(await services.context(request, request.params.targetId), request.query.path, signal),
      ),
  )
}
