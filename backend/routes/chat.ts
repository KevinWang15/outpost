import type { FastifyInstance } from 'fastify'
import { imageMediaTypes } from '../../shared/images'
import { desktopOrigin } from '../../shared/desktopAuth'
import { chatProtocol } from '../../shared/chatApi'
import { AppError } from '../errors'
import type { Services } from '../services'
import type { DesktopAccess } from '../desktop-access'
import { chatImageBytes, type ChatServer } from '../chat/socket'
import type { Owner } from '../deployment'
import { sessionFileId } from '../../shared/sessionFiles'
import { withRequestSignal } from '../request'
import type { SessionFileDownload } from './sessionFiles'

export function chatRoutes(
  app: FastifyInstance,
  services: Services,
  chat: ChatServer,
  access: DesktopAccess,
  download: SessionFileDownload,
) {
  /** The page's chat grant, as for image uploads; resolving the target checks ownership. */
  const owner = (authorization: string | undefined) => {
    const match = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/.exec(authorization ?? '')
    const found = match ? chat.tokens.authorize(match[1]) : null
    if (!found || !services.active(found)) throw new AppError('This chat authorization expired. Reload the page.', 401)
    return found
  }
  const session = (params: { sessionId: string }) => {
    if (!/^[0-9a-f-]{36}$/.test(params.sessionId)) throw new AppError('Invalid session.')
    return params.sessionId
  }

  // A session's published files (Outpost MCP publish_file), stored on its target.
  type FileParams = { targetId: string; sessionId: string; fileId: string }
  app.get<{ Params: Omit<FileParams, 'fileId'> }>('/api/chat/files/:targetId/:sessionId', (request, reply) =>
    withRequestSignal(reply, async signal => {
      const who = owner(request.headers.authorization)
      const context = await services.resolve(who, request.params.targetId)
      reply.header('Cache-Control', 'no-store')
      return services.files.list(context, session(request.params), signal)
    }),
  )
  app.get<{ Params: FileParams }>('/api/chat/files/:targetId/:sessionId/:fileId', (request, reply) =>
    download(
      reply,
      owner(request.headers.authorization),
      request.params.targetId,
      session(request.params),
      request.params.fileId,
    ),
  )
  app.delete<{ Params: FileParams }>('/api/chat/files/:targetId/:sessionId/:fileId', async (request, reply) => {
    const who = owner(request.headers.authorization)
    if (!sessionFileId(request.params.fileId)) throw new AppError('Invalid session file ID.')
    const context = await services.resolve(who, request.params.targetId)
    await services.files.remove(context, session(request.params), request.params.fileId)
    return reply.send({ ok: true })
  })

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
