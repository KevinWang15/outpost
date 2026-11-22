import { machineReleaseBase } from './machineInstaller'
import { supportsTerminal } from '../shared/harnesses'
import { createHmac } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Services } from './services'
import type { DesktopAccess } from './desktop-access'
import { directAuthority } from '../shared/node/directTickets'
import { AppError } from './errors'

// Only schema-validated owner operations are delegated. Neither an account
// bearer nor a machine-management stream passes through the public endpoint.
const operations: Record<string, string> = {
  'GET /sessions': 'list',
  'POST /sessions': 'create',
  'GET /sessions/:sessionId': 'get',
  'PATCH /sessions/:sessionId': 'update',
  'DELETE /sessions/:sessionId': 'delete',
  'POST /sessions/:sessionId/terminate': 'terminate',
  'POST /sessions/:sessionId/switch': 'switch',
  'POST /sessions/:sessionId/acknowledge': 'acknowledge',
  'POST /sessions/:sessionId/fork': 'fork',
  'POST /conversations/search': 'search',
  'GET /directories': 'directories',
  'GET /software': 'software',
  'GET /session-options': 'options',
  'POST /sessions/:sessionId/connect': 'connect',
}
export function directRoutes(app: FastifyInstance, s: Services, desktop: DesktopAccess) {
  app.post<{ Params: { targetId: string } }>('/api/targets/:targetId/direct-install', async req => {
    const { target, owner } = await s.context(req, req.params.targetId)
    if (target.kind !== 'direct') throw new AppError('Choose a direct-only machine.', 400)
    const { publicKey } = directAuthority(s.deployment.secret, owner.userId, target.id)
    return {
      config: { origin: s.deployment.origin(req), targetId: target.id, endpoint: target.endpoint, publicKey },
      releaseBase: machineReleaseBase(),
    }
  })
  app.addHook('preHandler', async (req, reply) => {
    const route = req.routeOptions.url ?? ''
    const match = /^\/api\/(desktop\/)?targets\/:targetId(\/.*)$/.exec(route)
    if (!match) return
    const op = operations[req.method + ' ' + match[2]]
    if (!op) return
    const { targetId, sessionId } = req.params as { targetId: string; sessionId?: string }
    const owner = match[1] ? desktop.authorize(req) : s.deployment.owner(req)
    const target = await s.deployment.workspace(owner).get(targetId)
    if (target.kind !== 'direct') return
    if (!s.active(owner)) throw new AppError('Sign in again.', 401)
    if (op === 'connect') {
      if (!sessionId || !/^[\w-]{1,128}$/.test(sessionId)) throw new AppError('Invalid session.', 400)
      const launch = s.tokens.issue({ owner, targetId, sessionId })
      return reply.send(
        match[1]
          ? {
              server: s.deployment.origin(req),
              accountId: owner.userId,
              loginId: owner.loginId,
              targetId,
              sessionId,
              title: target.name,
              token: launch.token,
            }
          : launch,
      )
    }
    const desktopRequest = !!match[1]
    const body = req.body as { requestId?: string; input?: { tool: string }; tool?: string } | undefined
    const input = op === 'create' && desktopRequest ? body?.input : body
    if (op === 'create' && !target.tools.some(tool => tool === input?.tool && supportsTerminal(tool)))
      throw new AppError('Add this coding tool to the machine first.', 400)
    const creationKey =
      op === 'create' && desktopRequest
        ? createHmac('sha256', s.deployment.secret)
            .update(JSON.stringify([owner.userId, targetId, body?.requestId]))
            .digest('hex')
        : undefined
    const ticket = directAuthority(s.deployment.secret, owner.userId, target.id).issue('request', {
      op,
      sessionId,
      desktop: desktopRequest,
      tools: target.tools.filter(supportsTerminal),
      name: target.name,
      input,
      query: req.query,
      creationKey,
    })
    return reply.header('x-outpost-direct', '1').send({ endpoint: target.endpoint, ticket })
  })
}
