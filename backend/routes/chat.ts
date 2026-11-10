import type { FastifyInstance } from 'fastify'
import { imageMediaTypes } from '../../shared/images'
import { desktopOrigin } from '../../shared/desktopAuth'
import { chatProtocol } from '../../shared/chatApi'
import { AppError } from '../errors'
import type { Services } from '../services'
import type { DesktopAccess } from '../desktop-access'
import { chatImageBytes, type ChatServer } from '../chat/socket'
import type { Owner } from '../deployment'

export function chatRoutes(app: FastifyInstance, services: Services, chat: ChatServer, access: DesktopAccess) {
  app.get<{ Querystring: { ticket?: string; protocol?: string } }>(
    '/api/chat',
    { websocket: true },
    (socket, request) => {
      void chat.accept(socket, request)
    },
  )

  // Prompt images: authenticated with the page's chat grant before buffering.
  app.register(async uploads => {
    uploads.removeAllContentTypeParsers()
    uploads.addContentTypeParser([...imageMediaTypes], { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    )
    const owners = new WeakMap<object, Owner>()
    uploads.post<{ Body: Buffer }>(
      '/api/chat/images',
      {
        bodyLimit: chatImageBytes,
        onRequest: async request => {
          const match = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/.exec(request.headers.authorization ?? '')
          const owner = match ? chat.tokens.authorize(match[1]) : null
          if (!owner || !services.active(owner))
            throw new AppError('This chat authorization expired. Reload the page.', 401)
          owners.set(request, owner)
        },
      },
      async (request, reply) => {
        const owner = owners.get(request)!
        const mediaType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() ?? ''
        if (!Buffer.isBuffer(request.body) || !(imageMediaTypes as readonly string[]).includes(mediaType))
          throw new AppError('Use a PNG, JPEG, GIF, or WebP image.', 415)
        return reply.code(201).send({
          id: chat.uploads.put(owner, mediaType, request.body),
          mimeType: mediaType,
          size: request.body.length,
        })
      },
    )
  })

  /** Outpost Desktop's chat window: a ticket for one chat socket, from the app login. */
  app.post('/api/desktop/chat/connect', async request => {
    const owner = access.authorize(request)
    if (!services.active(owner)) throw new AppError('App sign-in expired.', 401)
    return {
      server: desktopOrigin(services.deployment.origin(request)),
      accountId: owner.userId,
      ticket: chat.tokens.ticket(owner),
      protocol: chatProtocol,
    }
  })
}
