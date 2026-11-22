// Owner-approved enrollment and the long-lived, target-initiated machine link.
import { randomBytes, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { createWebSocketStream } from 'ws'
import type { Services } from './services'
import { AppError } from './errors'
import type { Deployment, Owner } from './deployment'
import { managedSocket } from './machines'

const digest = (s: string) => createHash('sha256').update(s).digest('hex')
const credential = () => randomBytes(32).toString('base64url')
type Identity = { userId: string; targetId: string; hash: string }
const keyPath = (deployment: Deployment, id: string) => join(deployment.directory, 'machine-enrollments', id + '.json')
function enrollment(deployment: Deployment, id: string): Identity | undefined {
  try {
    return JSON.parse(readFileSync(keyPath(deployment, id), 'utf8')) as Identity
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export function enrollmentRoutes(app: FastifyInstance, services: Services) {
  const pending = new Map<string, { owner: Owner; targetId: string; expires: number }>()
  const directory = join(services.deployment.directory, 'machine-enrollments')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const identity = (bearer: string | undefined) => {
    const match = /^Bearer ([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(bearer ?? '')
    if (match) {
      try {
        const saved = enrollment(services.deployment, match[1])
        if (
          saved?.targetId === match[1] &&
          saved.hash === digest(match[2]) &&
          services.deployment.account(saved.userId)
        )
          return saved
      } catch {
        /* Missing or revoked enrollment. */
      }
    }
    throw new AppError('Invalid machine credential. Enroll the machine again.', 401)
  }
  const outbound = async (owner: Owner, targetId: string) => {
    const target = await services.deployment.workspace(owner).get(targetId)
    if (target.kind !== 'outbound')
      throw new AppError('Choose Run setup on the machine to enroll an outbound machine.', 400)
    return target
  }

  app.get<{ Params: { targetId: string } }>('/api/targets/:targetId/enrollment', async req => {
    const owner = services.deployment.owner(req)
    await outbound(owner, req.params.targetId)
    const context = await services.resolve(owner, req.params.targetId)
    return {
      enrolled: enrollment(services.deployment, req.params.targetId)?.userId === owner.userId,
      connected: context.machine.connected,
    }
  })
  app.post<{ Params: { targetId: string } }>('/api/targets/:targetId/enrollment', async req => {
    const owner = services.deployment.owner(req)
    await outbound(owner, req.params.targetId)
    for (const [key, item] of pending)
      if (item.expires <= Date.now() || (item.owner.userId === owner.userId && item.targetId === req.params.targetId))
        pending.delete(key)
    const code = credential(),
      expires = Date.now() + 5 * 60_000
    pending.set(digest(code), { owner, targetId: req.params.targetId, expires })
    return {
      code,
      expiresAt: new Date(expires).toISOString(),
      origin: services.deployment.machineOrigin ?? services.deployment.origin(req),
    }
  })
  app.post<{ Body: { code: string } }>(
    '/api/machine/enroll',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code'],
          properties: { code: { type: 'string', maxLength: 64 } },
        },
      },
    },
    async req => {
      const key = digest(req.body.code),
        item = pending.get(key)
      pending.delete(key)
      if (!item || item.expires <= Date.now() || !services.deployment.active(item.owner))
        throw new AppError('The enrollment code is invalid or expired.', 401)
      await outbound(item.owner, item.targetId)
      if (enrollment(services.deployment, item.targetId))
        throw new AppError('This machine already has an enrollment. Release it before enrolling another host.', 409)
      const secret = credential(),
        path = keyPath(services.deployment, item.targetId)
      writeFileSync(
        path + '.new',
        JSON.stringify({ userId: item.owner.userId, targetId: item.targetId, hash: digest(secret) }),
        { mode: 0o600 },
      )
      renameSync(path + '.new', path)
      services.broker.closeTarget(item.owner, item.targetId)
      services.machines.forget(item.owner, item.targetId)
      return {
        targetId: item.targetId,
        socket: managedSocket(services.deployment.secret, item.owner, item.targetId),
        credential: item.targetId + '.' + secret,
      }
    },
  )
  app.post('/api/machine/revoke', async (req, reply) => {
    const saved = identity(req.headers.authorization)
    unlinkSync(keyPath(services.deployment, saved.targetId))
    services.broker.closeTarget({ userId: saved.userId, loginId: 'background' }, saved.targetId)
    services.machines.forget({ userId: saved.userId, loginId: 'background' }, saved.targetId)
    return reply.code(204).send()
  })
  app.get(
    '/api/machine/connect',
    {
      websocket: true,
      preValidation: async req => {
        identity(req.headers.authorization)
      },
    },
    (ws, req) => {
      ws.on('error', () => ws.terminate())
      const saved = identity(req.headers.authorization)
      const owner = { userId: saved.userId, loginId: 'background' }
      void (async () => {
        const context = await services.resolve(owner, saved.targetId)
        if (
          context.target.kind !== 'outbound' ||
          identity(req.headers.authorization).hash !== saved.hash ||
          ws.readyState !== ws.OPEN
        )
          return ws.close()
        ws.send(JSON.stringify({ socket: context.machine.socket }))
        context.machine.register(createWebSocketStream(ws), () => {
          if (!context.target.environment && services.installations.latest(owner, saved.targetId)?.status !== 'running')
            void services.installations.start(context).catch(error => app.log.error(error))
        })
        let alive = true
        ws.on('pong', () => {
          alive = true
        })
        const heartbeat = setInterval(() => {
          if (!alive || !services.deployment.account(saved.userId)) return ws.terminate()
          alive = false
          ws.ping()
        }, 15000).unref()
        ws.once('close', () => clearInterval(heartbeat))
      })().catch(() => ws.close(1008, 'Machine registration failed'))
    },
  )
  return (targetId: string) => {
    if (!/^[a-f0-9-]{36}$/.test(targetId)) return
    try {
      unlinkSync(keyPath(services.deployment, targetId))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    for (const [key, item] of pending) if (item.targetId === targetId) pending.delete(key)
  }
}
