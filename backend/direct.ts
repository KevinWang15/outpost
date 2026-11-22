import { machineReleaseBase } from './machineInstaller'
import { supportsTerminal } from '../shared/harnesses'
import { sessionCreationKey } from './session-actions'
import type { FastifyInstance } from 'fastify'
import type { Services } from './services'
import type { DesktopAccess } from './desktop-access'
import { machineAuthority } from './paired'
import { machineEndpoint } from '../shared/model'
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
}
export function directRoutes(app: FastifyInstance, s: Services, desktop: DesktopAccess) {
  app.post<{ Params: { targetId: string } }>('/api/targets/:targetId/direct-install', async req => {
    const { target, owner } = await s.context(req, req.params.targetId)
    if (target.kind !== 'direct') throw new AppError('Choose a direct-only machine.', 400)
    const { publicKey, proofKey } = machineAuthority(s.deployment, owner, target)!
    return {
      config: { origin: s.deployment.origin(req), targetId: target.id, publicKey, proofKey },
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
    const endpoint = machineEndpoint(target)
    if (!endpoint) return
    if (target.kind === 'paired' && (await s.resolve(owner, targetId)).machine.relayConnected) return
    const authority = machineAuthority(s.deployment, owner, target)
    if (!authority) throw new AppError('Enroll this machine before connecting.', 409)
    if (!s.active(owner)) throw new AppError('Sign in again.', 401)
    const desktopRequest = !!match[1]
    const body = req.body as { requestId?: string; input?: { tool: string }; tool?: string } | undefined
    const input = op === 'create' && desktopRequest ? body?.input : body
    if (op === 'create' && !target.tools.some(tool => tool === input?.tool && supportsTerminal(tool)))
      throw new AppError('Add this coding tool to the machine first.', 400)
    const ticket = authority.issue('request', {
      op,
      sessionId,
      desktop: desktopRequest,
      tools: target.tools.filter(supportsTerminal),
      name: target.name,
      input,
      query: req.query,
      creationKey:
        op === 'create' && desktopRequest ? sessionCreationKey(s, owner.userId, targetId, body?.requestId) : undefined,
    })
    return reply.header('x-outpost-direct', '1').send({ endpoint, ticket })
  })
}
