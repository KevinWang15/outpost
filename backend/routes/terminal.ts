import type { FastifyInstance } from 'fastify'
import { imageMediaTypes, maxImageBytes, type ImageMediaType } from '../../shared/images'
import { AppError } from '../errors'
import { withRequestSignal } from '../request'
import type { Services } from '../services'
import type { TerminalQuery } from '../terminal/broker'
import type { Grant } from '../terminal/tokens'

export function terminalRoutes(app: FastifyInstance, services: Services) {
  // Both clients authenticate with the same scoped terminal grant.
  app.get<{ Querystring: TerminalQuery }>('/api/terminal', { websocket: true }, (socket, request) => {
    void services.broker.accept(socket, request.query)
  })

  // Scope binary parsing to this endpoint. Authentication runs before buffering;
  // Fastify bounds the raw body to 16 MiB, without a base64/JSON expansion.
  app.register(async uploads => {
    uploads.removeAllContentTypeParsers()
    uploads.addContentTypeParser([...imageMediaTypes], { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    )
    const grants = new WeakMap<object, Grant>()
    uploads.post<{ Body: Buffer }>(
      '/api/terminal/image',
      {
        bodyLimit: maxImageBytes,
        onRequest: async request => {
          const authorization = request.headers.authorization
          const grant = authorization?.startsWith('Bearer ') ? services.tokens.authorize(authorization.slice(7)) : null
          if (!grant || !services.deployment.active(grant.owner))
            throw new AppError('This terminal authorization expired. Connect again from Outpost.', 401)
          grants.set(request, grant)
        },
      },
      async (request, reply) =>
        withRequestSignal(reply, async signal => {
          const grant = grants.get(request)!
          const mediaType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase()
          if (!Buffer.isBuffer(request.body) || !(imageMediaTypes as readonly string[]).includes(mediaType ?? ''))
            throw new AppError('Use a PNG, JPEG, GIF, or WebP image.', 415)
          if (!services.deployment.active(grant.owner)) throw new AppError('This terminal authorization expired.', 401)
          const context = await services.resolve(grant.owner, grant.targetId)
          return services.sessions.uploadImage(
            context,
            grant.sessionId,
            request.body,
            mediaType as ImageMediaType,
            signal,
          )
        }),
    )
  })
}
