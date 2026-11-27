// Owner-approved enrollment and the long-lived, target-initiated machine link.
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createWebSocketStream } from 'ws'
import type { OutboundEnrollmentReply } from '../shared/machine'
import type { OutboundEnrollmentInput, Target } from '../shared/model'
import { writeJsonFile } from '../shared/node/jsonFile'
import { outboundEnrollment, uuidRegex } from '../shared/schemas'
import type { Deployment, Owner } from './deployment'
import { AppError } from './errors'
import { machineSocket } from './machines'
import { RateLimit } from './rate-limit'
import type { Services } from './services'

const digest = (s: string) => createHash('sha256').update(s).digest('hex')
const maxPending = 256
type Identity = { userId: string; targetId: string; hash: string }
const keyPath = (deployment: Deployment, id: string) => join(deployment.directory, 'machine-enrollments', id + '.json')

async function enrollment(deployment: Deployment, id: string): Promise<Identity | undefined> {
  let raw: string
  try {
    raw = await readFile(keyPath(deployment, id), 'utf8')
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
  const connected = new WeakMap<FastifyRequest, Identity>()
  const limits = new RateLimit()
  const directory = join(services.deployment.directory, 'machine-enrollments')
  mkdirSync(directory, { recursive: true, mode: 0o700 })

  const identity = async (bearer: string | undefined) => {
    const match = /^Bearer ([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(bearer ?? '')
    if (match && uuidRegex.test(match[1])) {
      const saved = await enrollment(services.deployment, match[1])
      if (saved && saved.hash === digest(match[2]) && services.deployment.account(saved.userId)) return saved
    }
    throw new AppError('Invalid machine credential. Enroll the machine again.', 401)
  }
  const receipt = (saved: Identity): OutboundEnrollmentReply => ({
    targetId: saved.targetId,
    socket: machineSocket(services.deployment.secret, saved, saved.targetId),
  })
  const forgetEnrollment = async (targetId: string) => {
    if (!uuidRegex.test(targetId)) return
    try {
      await unlink(keyPath(services.deployment, targetId))
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
      enrolled: (await enrollment(services.deployment, req.params.targetId))?.userId === owner.userId,
      connected: context.machine.connected,
    }
  })
  app.post<{ Params: { targetId: string } }>('/api/targets/:targetId/enrollment', async req => {
    limits.consume(`issue:${req.ip}`, 60)
    const owner = services.deployment.owner(req)
    requireOutbound(await services.deployment.workspace(owner).get(req.params.targetId))
    const now = Date.now()
    for (const [key, item] of pending)
      if (item.expires <= now || (item.owner.userId === owner.userId && item.targetId === req.params.targetId))
        pending.delete(key)
    if (pending.size >= maxPending) pending.delete(pending.keys().next().value!)
    const code = randomBytes(32).toString('base64url'),
      expires = now + 5 * 60_000
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
      limits.consume(`enroll:${req.ip}`, 30)
      const { targetId, code, secret } = req.body
      const key = digest(code),
        hash = digest(secret)
      const item = pending.get(key)
      if (item?.targetId === targetId && item.expires > Date.now() && services.deployment.active(item.owner))
        requireOutbound(await services.deployment.workspace(item.owner).get(targetId))

      // Decide the claim after the last await. An overlapping redemption may
      // have stored this credential, or a removal may have invalidated the code.
      const saved = await enrollment(services.deployment, targetId)
      if (saved && saved.hash === hash && services.deployment.account(saved.userId)) {
        if (item?.targetId === targetId && item.owner.userId === saved.userId) pending.delete(key)
        return receipt(saved)
      }
      if (
        !item ||
        item.targetId !== targetId ||
        pending.get(key) !== item ||
        item.expires <= Date.now() ||
        !services.deployment.active(item.owner)
      )
        throw new AppError('The enrollment code is invalid or expired.', 401)
      if (saved) {
        pending.delete(key)
        throw new AppError('This machine already has an enrollment. Release it before enrolling another host.', 409)
      }
      const record: Identity = { userId: item.owner.userId, targetId, hash }
      await writeJsonFile(keyPath(services.deployment, targetId), record)
      pending.delete(key)
      return receipt(record)
    },
  )
  app.post('/api/machine/revoke', async (req, reply) => {
    limits.consume(`revoke:${req.ip}`, 30)
    const saved = await identity(req.headers.authorization)
    await forgetEnrollment(saved.targetId)
    services.broker.closeTarget({ userId: saved.userId, loginId: 'background' }, saved.targetId)
    services.machines.forget({ userId: saved.userId, loginId: 'background' }, saved.targetId)
    return reply.code(204).send()
  })
  app.get(
    '/api/machine/connect',
    {
      websocket: true,
      preValidation: async req => {
        connected.set(req, await identity(req.headers.authorization))
      },
    },
    (ws, req) => {
      ws.on('error', () => ws.terminate())
      const saved = connected.get(req)
      if (!saved) return ws.close(1008, 'Machine registration failed')
      const owner = { userId: saved.userId, loginId: 'background' }
      void (async () => {
        const context = await services.resolve(owner, saved.targetId)
        const current = await enrollment(services.deployment, saved.targetId)
        if (
          context.target.kind !== 'outbound' ||
          current?.hash !== saved.hash ||
          !services.deployment.account(saved.userId) ||
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
