import type { FastifyInstance } from 'fastify'
import Type from 'typebox'
import type { ConversationSearch, SessionForkInput, SessionInput, SessionUpdate } from '../../shared/model'
import {
  acknowledgeInput,
  conversationSearch,
  directoryQuery,
  sessionForkInput,
  sessionInput,
  sessionUpdate,
} from '../../shared/schemas'
import type { ChatHub } from '../chat/hub'
import { withRequestSignal } from '../request'
import type { Services } from '../services'
import {
  createSession,
  deleteSession,
  forkSession,
  newSessionConversation,
  switchSession,
  terminalLaunch,
  terminateSession,
  updateSession,
} from '../session-actions'

const emptyBody = Type.Object({}, { additionalProperties: false })
const switchBody = Type.Object(
  {
    conversation: Type.String({ minLength: 1, maxLength: 128 }),
    reclaim: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

type Params = { targetId: string; sessionId: string }
export function sessionRoutes(app: FastifyInstance, services: Services, hub: ChatHub) {
  const { sessions } = services
  const base = '/api/targets/:targetId/sessions'
  app.get<{ Params: Params }>(base, async (request, reply) =>
    withRequestSignal(reply, async signal =>
      sessions.list(await services.context(request, request.params.targetId), signal),
    ),
  )
  app.post<{ Params: Params; Body: SessionInput }>(base, { schema: { body: sessionInput } }, async (request, reply) => {
    const context = await services.context(request, request.params.targetId)
    return reply.code(201).send(await createSession(services, context, request.body))
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
      return reply.code(201).send(await forkSession(services, context, request.params.sessionId, request.body))
    },
  )
  // Name and delivery apply at once; harness, directory, conversation and launch settings when the session next starts.
  app.patch<{ Params: Params; Body: SessionUpdate }>(
    `${base}/:sessionId`,
    { schema: { body: sessionUpdate } },
    async request =>
      updateSession(
        services,
        await services.context(request, request.params.targetId),
        request.params.sessionId,
        request.body,
      ),
  )
  // Make an earlier conversation of the session current again (or reclaim a moved one).
  app.post<{ Params: Params; Body: { conversation: string; reclaim?: boolean } }>(
    `${base}/:sessionId/switch`,
    { schema: { body: switchBody } },
    async request =>
      switchSession(
        services,
        await services.context(request, request.params.targetId),
        request.params.sessionId,
        request.body.conversation,
        request.body.reclaim === true,
      ),
  )
  // Allocate a brand-new conversation for a stopped session.
  app.post<{ Params: Params }>(`${base}/:sessionId/conversations`, { schema: { body: emptyBody } }, async request =>
    newSessionConversation(
      services,
      await services.context(request, request.params.targetId),
      request.params.sessionId,
    ),
  )
  app.delete<{ Params: Params }>(`${base}/:sessionId`, async (request, reply) => {
    const context = await services.context(request, request.params.targetId)
    await deleteSession(services, context, request.params.sessionId, hub)
    return reply.code(204).send()
  })
  app.post<{ Params: Params }>(`${base}/:sessionId/terminate`, async request => {
    const context = await services.context(request, request.params.targetId)
    return terminateSession(services, context, request.params.sessionId)
  })
  app.post<{ Params: Params; Body: { completionId: string } }>(
    `${base}/:sessionId/acknowledge`,
    { schema: { body: acknowledgeInput } },
    async request =>
      sessions.acknowledge(
        await services.context(request, request.params.targetId),
        request.params.sessionId,
        request.body.completionId,
      ),
  )
  app.post<{ Params: Params }>(`${base}/:sessionId/connect`, { schema: { body: emptyBody } }, async (request, reply) =>
    withRequestSignal(reply, async signal => {
      const context = await services.context(request, request.params.targetId)
      return (await terminalLaunch(services, context, request.params.sessionId, signal)).launch
    }),
  )
  app.post<{ Params: Params; Body: ConversationSearch }>(
    '/api/targets/:targetId/conversations/search',
    { schema: { body: conversationSearch } },
    async (request, reply) =>
      withRequestSignal(reply, async signal =>
        sessions.search(await services.context(request, request.params.targetId), request.body, signal),
      ),
  )
  app.get<{ Params: Params; Querystring: { path: string } }>(
    '/api/targets/:targetId/directories',
    { schema: { querystring: directoryQuery } },
    async (request, reply) =>
      withRequestSignal(reply, async signal =>
        sessions.directories(await services.context(request, request.params.targetId), request.query.path, signal),
      ),
  )
}
