// Owner-approved enrollment and the long-lived, target-initiated machine link.
import { randomBytes, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { createWebSocketStream } from 'ws'
import type { Services } from './services'
import { AppError } from './errors'
import type { Deployment, Owner } from './deployment'
import type { Target } from '../shared/model'
import { directAuthority } from '../shared/node/directTickets'
import { managedSocket } from './machines'

const digest = (s: string) => createHash('sha256').update(s).digest('hex')
const credential = () => randomBytes(32).toString('base64url')
type Identity = { userId: string; targetId: string; hash: string }
const keyPath = (deployment: Deployment, id: string) => join(deployment.directory, 'paired-machines', id + '.json')
function pairing(deployment: Deployment, id: string): Identity | undefined {
  try {
    return JSON.parse(readFileSync(keyPath(deployment, id), 'utf8')) as Identity
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Replacement and revocation also invalidate the paired machine’s direct authority. */
export function machineAuthority(deployment: Deployment, owner: Owner, target: Target) {
  if (target.kind === 'direct') return directAuthority(deployment.secret, owner.userId, target.id)
  if (target.kind !== 'paired') return
  const identity = pairing(deployment, target.id)
  if (identity?.userId === owner.userId && identity.targetId === target.id)
    return directAuthority(deployment.secret, owner.userId, target.id, identity.hash)
}

export function pairedRoutes(app: FastifyInstance, services: Services) {
  const pending = new Map<string, { owner: Owner; targetId: string; expires: number }>()
  const directory = join(services.deployment.directory, 'paired-machines')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const identity = (bearer: string | undefined) => {
    const match = /^Bearer ([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(bearer ?? '')
    if (match) {
      try {
        const saved = pairing(services.deployment, match[1])
        if (
          saved?.targetId === match[1] &&
          saved.hash === digest(match[2]) &&
          services.deployment.account(saved.userId)
        )
          return saved
      } catch {
        /* Missing or removed pairing. */
      }
    }
    throw new AppError('Invalid machine credential. Enroll the machine again.', 401)
  }
  const paired = async (owner: Owner, targetId: string) => {
    const target = await services.deployment.workspace(owner).get(targetId)
    if (target.kind !== 'paired') throw new AppError('Choose a relay-enabled machine.', 400)
    return target
  }

  app.post<{ Params: { targetId: string } }>('/api/targets/:targetId/pair', async req => {
    const owner = services.deployment.owner(req)
    await paired(owner, req.params.targetId)
    for (const [key, item] of pending)
      if (item.expires <= Date.now() || (item.owner.userId === owner.userId && item.targetId === req.params.targetId))
        pending.delete(key)
    const code = credential(),
      expires = Date.now() + 5 * 60_000
    pending.set(digest(code), { owner, targetId: req.params.targetId, expires })
    return { code, expiresAt: new Date(expires).toISOString(), origin: services.deployment.origin(req) }
  })
  app.post<{ Body: { code: string } }>(
    '/api/paired/enroll',
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
        throw new AppError('The pairing code is invalid or expired.', 401)
      const target = await paired(item.owner, item.targetId)
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
      const authority = directAuthority(services.deployment.secret, item.owner.userId, target.id, digest(secret))
      return {
        publicKey: authority.publicKey,
        proofKey: authority.proofKey,
        targetId: item.targetId,
        socket: managedSocket(services.deployment.secret, item.owner, item.targetId),
        credential: item.targetId + '.' + secret,
      }
    },
  )
  app.post('/api/paired/revoke', async (req, reply) => {
    const saved = identity(req.headers.authorization)
    unlinkSync(keyPath(services.deployment, saved.targetId))
    services.broker.closeTarget({ userId: saved.userId, loginId: 'background' }, saved.targetId)
    services.machines.forget({ userId: saved.userId, loginId: 'background' }, saved.targetId)
    return reply.code(204).send()
  })
  app.get(
    '/api/paired/node',
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
          context.target.kind !== 'paired' ||
          identity(req.headers.authorization).hash !== saved.hash ||
          ws.readyState !== ws.OPEN
        )
          return ws.close()
        ws.send(JSON.stringify({ socket: context.machine.socket }))
        context.machine.register(createWebSocketStream(ws))
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
