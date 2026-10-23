import type { FastifyInstance } from 'fastify'
import { sessionFileId } from '../../shared/sessionFiles'
import { AppError } from '../errors'
import { withRequestSignal } from '../request'
import type { Services } from '../services'
import { terminalGrant } from '../terminal/authorization'

export function sessionFileRoutes(app: FastifyInstance, services: Services) {
  const files = services.files
  // Downloads are bounded per owner as well as per file; bulk reads cannot exhaust the server.
  const downloads = new Map<string, number>()
  app.get('/api/terminal/files', (request, reply) =>
    withRequestSignal(reply, async signal => {
      const grant = terminalGrant(services, request)
      reply.header('Cache-Control', 'no-store')
      const result = await files.list(await services.resolve(grant.owner, grant.targetId), grant.sessionId, signal)
      if (!services.active(grant.owner)) throw new AppError('Sign-in ended. Connect again.', 401)
      return result
    }),
  )
  app.get<{ Params: { fileId: string } }>('/api/terminal/files/:fileId', (request, reply) =>
    withRequestSignal(reply, async signal => {
      const grant = terminalGrant(services, request)
      if (!sessionFileId(request.params.fileId)) throw new AppError('Invalid session file ID.')
      const owner = grant.owner.userId
      if ((downloads.get(owner) ?? 0) >= 2 || [...downloads.values()].reduce((a, b) => a + b, 0) >= 4)
        throw new AppError('Too many file transfers. Try again shortly.', 429)
      downloads.set(owner, (downloads.get(owner) ?? 0) + 1)
      let released = false
      const release = () => {
        if (released) return
        released = true
        const count = (downloads.get(owner) ?? 1) - 1
        if (count) downloads.set(owner, count)
        else downloads.delete(owner)
      }
      try {
        const context = await services.resolve(grant.owner, grant.targetId)
        const { file, bytes } = await files.read(context, grant.sessionId, request.params.fileId, signal)
        if (!services.active(grant.owner)) throw new AppError('Sign-in ended. Connect again.', 401)
        reply
          .header('Cache-Control', 'no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .header(
            'Content-Disposition',
            `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`,
          )
          .type(file.mediaType)
        // Keep the slot while a slow client is still receiving the buffered file.
        reply.raw.once('close', release)
        return reply.send(bytes)
      } catch (error) {
        release()
        throw error
      }
    }),
  )
  app.delete<{ Params: { fileId: string } }>('/api/terminal/files/:fileId', async (request, reply) => {
    const grant = terminalGrant(services, request)
    if (!sessionFileId(request.params.fileId)) throw new AppError('Invalid session file ID.')
    await files.remove(await services.resolve(grant.owner, grant.targetId), grant.sessionId, request.params.fileId)
    services.broker.filesChanged(grant)
    return reply.send({ ok: true })
  })
}
