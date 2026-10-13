import type { FastifyInstance } from 'fastify'
import type { ConversationSearch, SessionImageInput, SessionInput } from '../../shared/model'
import { imageMediaTypes } from '../../shared/model'
import { harnesses, harnessIds } from '../../shared/harnesses'
import type { ConnectRequest, ConnectResponse, ConnectionStatus } from '../../shared/protocol'
import { terminalChoices } from '../../shared/terminals'
import { AppError } from '../errors'
import { withRequestSignal } from '../request'
import type { Services } from '../services'
import { launchOptions } from '../sessions'
import { nameField } from '../workspace'

type Params = { targetId: string; sessionId: string }
const textField = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength, pattern: '^[^\\u0000-\\u001f\\u007f]+$' })
const sessionInput = {
  // Each harness pins its own native ID format and storage variable.
  oneOf: harnesses.map(harness => ({ properties: {
    tool: { const: harness.id },
    cliSessionId: { type: 'string', pattern: harness.nativeId },
    cliSessionEnv: { type: 'object', propertyNames: { const: harness.storageKey } },
  } })),
  dependencies: { cliSessionEnv: ['cliSessionId'] },
  type: 'object', additionalProperties: false, required: ['name', 'rootDir', 'tool'],
  properties: {
    name: nameField,
    rootDir: { ...textField(4096), pattern: '^(~/|/)[^\\u0000-\\u001f\\u007f]*$' },
    createDirectory: { type: 'boolean' },
    tool: { enum: harnessIds },
    cliSessionId: { type: 'string', maxLength: 128 },
    cliSessionEnv: { type: 'object', minProperties: 1, maxProperties: 1, additionalProperties: { ...textField(4096), pattern: '^/[^\\u0000-\\u001f\\u007f]*$' } },
    args: { type: 'string', maxLength: 8192, pattern: '^[^\\u0000]*$' },
    env: {
      type: 'object', maxProperties: 32,
      propertyNames: { maxLength: 128, pattern: '^[A-Za-z_][A-Za-z0-9_]*(?![\\s\\S])' },
      additionalProperties: { type: 'string', maxLength: 4096, pattern: '^[^\\u0000]*$' },
    },
  },
}
const imageInput = {
  type: 'object', additionalProperties: false, required: ['data', 'mediaType'],
  properties: { data: { type: 'string', minLength: 8, maxLength: 24 * 1024 * 1024, pattern: '^[A-Za-z0-9+/]+={0,2}$' }, mediaType: { enum: imageMediaTypes } },
}

export function sessionRoutes(app: FastifyInstance, services: Services) {
  const { sessions, broker, tokens, deployment } = services
  const base = '/api/targets/:targetId/sessions'
  app.get<{ Params: Params }>(base, async (request, reply) => withRequestSignal(reply, async signal =>
    sessions.list(await services.context(request, request.params.targetId), signal)))
  app.post<{ Params: Params; Body: SessionInput }>(base, { schema: { body: sessionInput } }, async (request, reply) => {
    const context = await services.context(request, request.params.targetId)
    if (!context.target.tools.includes(request.body.tool)) throw new AppError('Add this coding tool to the target before creating a session.', 400)
    launchOptions(request.body)
    return reply.code(201).send(await sessions.create(context, request.body))
  })
  app.get<{ Params: Params }>(`${base}/:sessionId`, async (request, reply) => withRequestSignal(reply, async signal =>
    sessions.get(await services.context(request, request.params.targetId), request.params.sessionId, signal)))
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
  app.post<{ Params: Params; Body: { completionId: string } }>(`${base}/:sessionId/acknowledge`, {
    schema: { body: { type: 'object', additionalProperties: false, required: ['completionId'], properties: { completionId: { type: 'string', pattern: '^[0-9a-f]{64}$' } } } },
  }, async request => sessions.acknowledge(await services.context(request, request.params.targetId), request.params.sessionId, request.body.completionId))
  app.post<{ Params: Params; Body: SessionImageInput }>(`${base}/:sessionId/image`, { bodyLimit: 24 * 1024 * 1024, schema: { body: imageInput } }, async request =>
    sessions.pasteImage(await services.context(request, request.params.targetId), request.params.sessionId, request.body))
  app.post<{ Params: Params; Body: ConnectRequest }>(`${base}/:sessionId/connect`, {
    schema: { body: { type: 'object', additionalProperties: false, required: ['terminal'], properties: { terminal: { enum: terminalChoices } } } },
  }, async (request, reply) => withRequestSignal(reply, async signal => {
    const context = await services.context(request, request.params.targetId)
    const session = await sessions.get(context, request.params.sessionId, signal)
    const { terminal } = request.body
    const issued = tokens.issue({ owner: context.owner, targetId: context.target.id, sessionId: session.id, terminal })
    const link = { v: 1, server: deployment.origin(request), token: issued.token, terminal, title: `${session.name} · ${context.target.name}` }
    return { ...issued, url: terminal === 'web' ? null : `outpost://connect/${Buffer.from(JSON.stringify(link)).toString('base64url')}` } satisfies ConnectResponse
  }))
  app.get<{ Params: { id: string } }>('/api/connections/:id', async request =>
    ({ status: tokens.status(deployment.owner(request), request.params.id) }) satisfies ConnectionStatus)
  app.post<{ Params: Params; Body: ConversationSearch }>('/api/targets/:targetId/conversations/search', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['query'], properties: {
      query: { type: 'string', minLength: 1, maxLength: 256, pattern: '^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$' }, tool: { enum: harnessIds },
    } } },
  }, async (request, reply) => withRequestSignal(reply, async signal =>
    sessions.search(await services.context(request, request.params.targetId), request.body, signal)))
  app.get<{ Params: Params; Querystring: { path: string } }>('/api/targets/:targetId/directories', {
    schema: { querystring: { type: 'object', additionalProperties: false, required: ['path'], properties: {
      path: { type: 'string', maxLength: 4096, pattern: '^(|~|(?:~/|/)[^\\u0000-\\u001f\\u007f]*)$' },
    } } },
  }, async (request, reply) => withRequestSignal(reply, async signal =>
    sessions.directories(await services.context(request, request.params.targetId), request.query.path, signal)))
}
