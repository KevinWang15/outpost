// Owner-approved enrollment and the long-lived, target-initiated machine link.
import { randomBytes, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { createWebSocketStream } from 'ws'
import type { OutboundEnrollmentInput, Target } from '../shared/model'
import type { OutboundEnrollmentReply } from '../shared/machine'
import { outboundEnrollment } from '../shared/schemas'
import type { Services } from './services'
import { AppError } from './errors'
import type { Deployment, Owner } from './deployment'
import { machineSocket } from './machines'

const digest = (s: string) => createHash('sha256').update(s).digest('hex')
type Identity = { userId: string; targetId: string; hash: string }
const keyPath = (deployment: Deployment, id: string) => join(deployment.directory, 'machine-enrollments', id + '.json')
function enrollment(deployment: Deployment, id: string): Identity | undefined {
  let raw: string
  try {
    raw = readFileSync(keyPath(deployment, id), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return
  }
  try {
    const record = JSON.parse(raw) as Identity
    if (
      record &&
      record.targetId === id &&
      typeof record.userId === 'string' &&
      record.userId.length > 0 &&
      typeof record.hash === 'string' &&
      /^[a-f0-9]{64}$/.test(record.hash) &&
      Object.keys(record).length === 3
    )
      return record
  } catch {
    // Invalid JSON and a stale record have the same recovery path.
  }
  throw new AppError('Invalid machine enrollment record. Remove the machine to release it.', 409)
}

function requireOutbound(target: Target) {
  if (target.kind !== 'outbound')
    throw new AppError('Choose Run setup on the machine to enroll an outbound machine.', 400)
}

export function enrollmentRoutes(app: FastifyInstance, services: Services) {
  const pending = new Map<string, { owner: Owner; targetId: string; expires: number }>()
  const directory = join(services.deployment.directory, 'machine-enrollments')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const identity = (bearer: string | undefined) => {
    const match = /^Bearer ([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(bearer ?? '')
    if (match) {
      const saved = enrollment(services.deployment, match[1])
      if (saved && saved.hash === digest(match[2]) && services.deployment.account(saved.userId)) return saved
    }
    throw new AppError('Invalid machine credential. Enroll the machine again.', 401)
  }
  const receipt = (saved: Identity): OutboundEnrollmentReply => ({
    targetId: saved.targetId,
    socket: machineSocket(services.deployment.secret, saved, saved.targetId),
  })
  const forgetEnrollment = (targetId: string) => {
    if (!/^[a-f0-9-]{36}$/.test(targetId)) return
    try {
      unlinkSync(keyPath(services.deployment, targetId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const [key, item] of pending) if (item.targetId === targetId) pending.delete(key)
  }

  app.get<{ Params: { targetId: string } }>('/api/targets/:targetId/enrollment', async req => {
    const owner = services.deployment.owner(req)
    const context = await services.resolve(owner, req.params.targetId)
    requireOutbound(context.target)
    return {
      enrolled: enrollment(services.deployment, req.params.targetId)?.userId === owner.userId,
      connected: context.machine.connected,
    }
  })
  app.post<{ Params: { targetId: string } }>('/api/targets/:targetId/enrollment', async req => {
    const owner = services.deployment.owner(req)
    requireOutbound(await services.deployment.workspace(owner).get(req.params.targetId))
    for (const [key, item] of pending)
      if (item.expires <= Date.now() || (item.owner.userId === owner.userId && item.targetId === req.params.targetId))
        pending.delete(key)
    const code = randomBytes(32).toString('base64url'),
      expires = Date.now() + 5 * 60_000
    pending.set(digest(code), { owner, targetId: req.params.targetId, expires })
    return {
      code,
      expiresAt: new Date(expires).toISOString(),
      origin: services.deployment.machineOrigin ?? services.deployment.origin(req),
    }
  })
  app.post<{ Body: OutboundEnrollmentInput }>(
    '/api/machine/enroll',
    { schema: { body: outboundEnrollment } },
    async req => {
      const { targetId, code, secret } = req.body
      const key = digest(code),
        hash = digest(secret)
      const item = pending.get(key)
      const saved = enrollment(services.deployment, targetId)
      // A machine that lost its receipt can prove its original claim after the code expires.
      if (saved && saved.hash === hash && services.deployment.account(saved.userId)) {
        if (item?.targetId === targetId && item.owner.userId === saved.userId) pending.delete(key)
        return receipt(saved)
      }
      if (!item || item.targetId !== targetId || item.expires <= Date.now() || !services.deployment.active(item.owner))
        throw new AppError('The enrollment code is invalid or expired.', 401)
      requireOutbound(await services.deployment.workspace(item.owner).get(targetId))
      // A new command or removal can invalidate this claim while the workspace is read.
      if (pending.get(key) !== item || item.expires <= Date.now() || !services.deployment.active(item.owner))
        throw new AppError('The enrollment code is invalid or expired.', 401)
      pending.delete(key)
      if (enrollment(services.deployment, targetId))
        throw new AppError('This machine already has an enrollment. Release it before enrolling another host.', 409)
      const record = { userId: item.owner.userId, targetId, hash }
      const path = keyPath(services.deployment, targetId)
      writeFileSync(path + '.new', JSON.stringify(record), { mode: 0o600, flush: true })
      renameSync(path + '.new', path)
      return receipt(record)
    },
  )
  app.post('/api/machine/revoke', async (req, reply) => {
    const saved = identity(req.headers.authorization)
    forgetEnrollment(saved.targetId)
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
  return forgetEnrollment
}
