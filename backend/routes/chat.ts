import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { desktopOrigin } from '../../shared/desktopAuth'
import { chatProtocol } from '../../shared/chatApi'
import { AppError } from '../errors'
import type { Services } from '../services'
import type { DesktopAccess } from '../desktop-access'
import type { ChatServer } from '../chat/socket'
import type { Owner } from '../deployment'
import { maxSessionFileBytes, sessionFileId, sessionFileName } from '../../shared/sessionFiles'
import { withRequestSignal } from '../request'
import { sendAttachment, type SessionFileDownload } from './sessionFiles'

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
  const channel = (params: { channelId: string }) => {
    if (!/^[0-9a-f-]{36}$/.test(params.channelId)) throw new AppError('Invalid channel.')
    return params.channelId
  }

  // A session's files (published by its agent or sent to it), stored on its target.
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

  // Files the user attaches: raw bytes, authenticated with the page's chat grant
  // before buffering. A session's go to its store on the target; a channel's
  // wait on the server until the post commits them.
  app.register(async uploads => {
    uploads.removeAllContentTypeParsers()
    uploads.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    )
    const owners = new WeakMap<object, Owner>()
    const active = new Map<string, number>()
    const options = {
      bodyLimit: maxSessionFileBytes,
      onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
        const who = owner(request.headers.authorization)
        // Each upload is buffered in memory; bound them per account. The slot is
        // released when the response ends or the connection drops mid-upload.
        if ((active.get(who.userId) ?? 0) >= 2) throw new AppError('Too many uploads at once. Try again shortly.', 429)
        active.set(who.userId, (active.get(who.userId) ?? 0) + 1)
        reply.raw.once('close', () => {
          const count = (active.get(who.userId) ?? 1) - 1
          if (count) active.set(who.userId, count)
          else active.delete(who.userId)
        })
        owners.set(request, who)
      },
    }
    const upload = (request: { body: unknown; query: { name?: string } }) => {
      if (!Buffer.isBuffer(request.body)) throw new AppError('Send the file as application/octet-stream.', 415)
      if (!sessionFileName(request.query.name))
        throw new AppError('Use a filename without folders or control characters.')
      return { name: request.query.name, data: request.body }
    }
    uploads.post<{ Params: { targetId: string; sessionId: string }; Querystring: { name?: string }; Body: Buffer }>(
      '/api/chat/files/:targetId/:sessionId',
      options,
      (request, reply) =>
        withRequestSignal(reply, async signal => {
          const { name, data } = upload(request)
          const context = await services.resolve(owners.get(request)!, request.params.targetId)
          return reply
            .code(201)
            .send(await services.files.receive(context, session(request.params), name, data, signal))
        }),
    )
    uploads.post<{ Params: { channelId: string }; Querystring: { name?: string }; Body: Buffer }>(
      '/api/chat/channels/:channelId/files',
      options,
      async (request, reply) => {
        const { name, data } = upload(request)
        return reply.code(201).send(await chat.hub.stageFile(owners.get(request)!, channel(request.params), name, data))
      },
    )
  })

  // Files attached to the user's channel posts.
  app.get<{ Params: { channelId: string } }>('/api/chat/channels/:channelId/files', async (request, reply) => {
    const who = owner(request.headers.authorization)
    reply.header('Cache-Control', 'no-store')
    return chat.hub.channelFiles(who, channel(request.params))
  })
  app.get<{ Params: { channelId: string; fileId: string } }>(
    '/api/chat/channels/:channelId/files/:fileId',
    async (request, reply) => {
      const who = owner(request.headers.authorization)
      const { file, bytes } = await chat.hub.readChannelFile(who, channel(request.params), request.params.fileId)
      return sendAttachment(reply, file, bytes)
    },
  )

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
