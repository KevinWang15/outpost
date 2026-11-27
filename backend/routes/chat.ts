import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { uuidRegex } from '../../shared/schemas'
import { maxSessionFileBytes, sessionFileId, sessionFileName, type SessionFile } from '../../shared/sessionFiles'
import type { ChatServer } from '../chat/socket'
import type { Owner } from '../deployment'
import { AppError } from '../errors'
import { withRequestSignal } from '../request'
import type { Services } from '../services'

/** A stored file's bytes as a download, never rendered by the browser. */
const sendAttachment = (reply: FastifyReply, file: SessionFile, bytes: Buffer) =>
  reply
    .header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`,
    )
    .type(file.mediaType)
    .send(bytes)

/** Bounded concurrent transfer slots (per account and globally) so buffered transfers cannot exhaust memory. */
function transferLimiter(perUser: number, globalLimit: number, message: string) {
  const counts = new Map<string, number>()
  let total = 0
  return (userId: string) => {
    if ((counts.get(userId) ?? 0) >= perUser || total >= globalLimit) throw new AppError(message, 429)
    counts.set(userId, (counts.get(userId) ?? 0) + 1)
    total++
    let released = false
    return () => {
      if (released) return
      released = true
      total--
      const remaining = (counts.get(userId) ?? 1) - 1
      if (remaining) counts.set(userId, remaining)
      else counts.delete(userId)
    }
  }
}

export function chatRoutes(app: FastifyInstance, services: Services, chat: ChatServer) {
  /** The page's chat grant, as for image uploads; resolving the target checks ownership. */
  const owner = (authorization: string | undefined) => {
    const match = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/.exec(authorization ?? '')
    const found = match ? chat.tokens.authorize(match[1]) : null
    if (!found || !services.active(found)) throw new AppError('This chat authorization expired. Reload the page.', 401)
    return found
  }
  const session = (params: { sessionId: string }) => {
    if (!uuidRegex.test(params.sessionId)) throw new AppError('Invalid session.')
    return params.sessionId
  }
  const channel = (params: { channelId: string }) => {
    if (!uuidRegex.test(params.channelId)) throw new AppError('Invalid channel.')
    return params.channelId
  }
  const acquireDownload = transferLimiter(2, 4, 'Too many file transfers. Try again shortly.')

  // A session's files (published by its agent or sent to it), stored on its target.
  type FileParams = { targetId: string; sessionId: string; fileId: string }
  app.get<{ Params: Omit<FileParams, 'fileId'> }>('/api/chat/files/:targetId/:sessionId', (request, reply) =>
    withRequestSignal(reply, async signal => {
      const who = owner(request.headers.authorization)
      const context = await services.resolve(who, request.params.targetId)
      return services.files.list(context, session(request.params), signal)
    }),
  )
  app.get<{ Params: FileParams }>('/api/chat/files/:targetId/:sessionId/:fileId', (request, reply) =>
    withRequestSignal(reply, async signal => {
      const who = owner(request.headers.authorization)
      const sessionId = session(request.params)
      const { fileId, targetId } = request.params
      if (!sessionFileId(fileId)) throw new AppError('Invalid session file ID.')
      const release = acquireDownload(who.userId)
      try {
        const context = await services.resolve(who, targetId)
        const { file, bytes } = await services.files.read(context, sessionId, fileId, signal)
        if (!services.active(who)) throw new AppError('Sign-in ended. Connect again.', 401)
        // Keep the slot while a slow client is still receiving the buffered file.
        reply.raw.once('close', release)
        return sendAttachment(reply, file, bytes)
      } catch (error) {
        release()
        throw error
      }
    }),
  )
  app.delete<{ Params: FileParams }>('/api/chat/files/:targetId/:sessionId/:fileId', async (request, reply) => {
    const who = owner(request.headers.authorization)
    if (!sessionFileId(request.params.fileId)) throw new AppError('Invalid session file ID.')
    const context = await services.resolve(who, request.params.targetId)
    await services.files.remove(context, session(request.params), request.params.fileId)
    return reply.send({ ok: true })
  })

  app.get<{ Querystring: { protocol?: string } }>('/api/chat', { websocket: true }, (socket, request) => {
    void chat.accept(socket, request)
  })

  // Files the user attaches: raw bytes, authenticated with the page's chat grant
  // before buffering. A session's go to its store on the target; a channel's
  // wait on the server until the post commits them.
  app.register(async uploads => {
    uploads.removeAllContentTypeParsers()
    uploads.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    )
    const owners = new WeakMap<object, Owner>()
    const acquireUpload = transferLimiter(2, 4, 'Too many uploads at once. Try again shortly.')
    const options = {
      bodyLimit: maxSessionFileBytes,
      onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
        const who = owner(request.headers.authorization)
        // Each upload is buffered in memory; bound them per account and globally.
        // The slot is released when the response ends or the connection drops mid-upload.
        const release = acquireUpload(who.userId)
        reply.raw.once('close', release)
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
  app.get<{ Params: { channelId: string } }>('/api/chat/channels/:channelId/files', async request => {
    const who = owner(request.headers.authorization)
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
}
