import type { FastifyInstance } from 'fastify'
import Type from 'typebox'
import { desktopOrigin, desktopProofPattern, type DesktopSession, type DesktopLaunch } from '../../shared/desktopAuth'
import { AppError } from '../errors'
import type { DesktopAccess } from '../desktop-access'
import { RateLimit } from '../rate-limit'
import { withRequestSignal } from '../request'
import type { Services } from '../services'

const proof = Type.String({ pattern: desktopProofPattern })
const strict = { additionalProperties: false }
type Params = { targetId: string; sessionId: string }

/** App bearers can only browse sessions and issue scoped terminal launches.
 * Browser credentials alone can approve access; app credentials cannot approve themselves. */
export function desktopRoutes(app: FastifyInstance, services: Services, access: DesktopAccess) {
  const { deployment, sessions, tokens } = services
  const limits = new RateLimit()
  app.post<{ Body: { challenge: string; state: string; accountId?: string } }>(
    '/api/desktop/authorizations',
    {
      schema: {
        body: Type.Object(
          {
            challenge: proof,
            state: proof,
            accountId: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_-]{1,128}$' })),
          },
          strict,
        ),
      },
    },
    async request => {
      desktopOrigin(deployment.origin(request))
      limits.consume(`start:${request.ip}`, 30)
      return access.start(request.body.challenge, request.body.state, request.body.accountId)
    },
  )
  app.get<{ Params: { id: string } }>('/api/desktop/authorizations/:id', async request => {
    deployment.owner(request)
    limits.consume(`review:${request.ip}`, 120)
    return access.describe(request.params.id)
  })
  app.post<{ Params: { id: string }; Body: { allow: boolean; accountId: string } }>(
    '/api/desktop/authorizations/:id',
    {
      schema: {
        body: Type.Object({ allow: Type.Boolean(), accountId: Type.String({ minLength: 1, maxLength: 128 }) }, strict),
      },
    },
    async request => {
      const owner = deployment.owner(request)
      if (owner.userId !== request.body.accountId)
        throw new AppError('Your signed-in account changed. Reload this page before connecting the app.', 409)
      limits.consume(`approve:${request.ip}`, 60)
      return access.approve(request.params.id, owner, request.body.allow)
    },
  )
  app.post<{ Body: { code: string; verifier: string } }>(
    '/api/desktop/token',
    {
      schema: { body: Type.Object({ code: proof, verifier: proof }, strict) },
    },
    async request => {
      limits.consume(`exchange:${request.ip}`, 60)
      return access.exchange(request.body.code, request.body.verifier)
    },
  )
  app.get('/api/desktop/account', async request => access.describeLogin(access.authorize(request)))
  app.post('/api/desktop/logout', async (request, reply) => {
    access.revoke(access.authorize(request))
    return reply.code(204).send()
  })
  app.get('/api/desktop/targets', async request => {
    const owner = access.authorize(request)
    const targets = await deployment.workspace(owner).list()
    if (!access.active(owner)) throw new AppError('App sign-in expired.', 401)
    return targets.map(({ id, name }) => ({ id, name }))
  })
  app.get<{ Params: Params }>('/api/desktop/targets/:targetId/sessions', async (request, reply) =>
    withRequestSignal(reply, async signal => {
      const owner = access.authorize(request)
      const context = await services.resolve(owner, request.params.targetId)
      const result = await sessions.list(context, signal)
      if (!access.active(owner)) throw new AppError('App sign-in expired.', 401)
      return result.sessions.map(
        session =>
          ({
            sessionId: session.id,
            targetId: context.target.id,
            title: `${session.name} · ${context.target.name}`,
            detail: `${session.tool} · ${session.rootDir} · ${session.status}`,
          }) satisfies DesktopSession,
      )
    }),
  )
  app.post<{ Params: Params }>('/api/desktop/targets/:targetId/sessions/:sessionId/connect', async (request, reply) =>
    withRequestSignal(reply, async signal => {
      const owner = access.authorize(request)
      const context = await services.resolve(owner, request.params.targetId)
      const session = await sessions.get(context, request.params.sessionId, signal)
      if (!access.active(owner)) throw new AppError('App sign-in expired.', 401)
      const grant = { owner, targetId: context.target.id, sessionId: session.id }
      return {
        server: desktopOrigin(deployment.origin(request)),
        accountId: owner.userId,
        targetId: context.target.id,
        sessionId: session.id,
        loginId: owner.loginId,
        token: tokens.issue(grant).token,
        title: `${session.name} · ${context.target.name}`,
      } satisfies DesktopLaunch
    }),
  )
}
