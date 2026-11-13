import type { FastifyInstance, FastifyReply } from 'fastify'
import { sessionFileId, type SessionFile } from '../../shared/sessionFiles'
import type { Owner } from '../deployment'
import { AppError } from '../errors'
import { withRequestSignal } from '../request'
import type { Services } from '../services'
import { terminalGrant } from '../terminal/authorization'

/** A stored file's bytes as a download, never rendered by the browser. */
export const sendAttachment = (reply: FastifyReply, file: SessionFile, bytes: Buffer) =>
  reply
    .header('Cache-Control', 'no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`,
    )
    .type(file.mediaType)
    .send(bytes)

/** A session file's bytes, as a download. Transfers are bounded per owner as
 * well as per file, so bulk reads cannot exhaust the server. */
export type SessionFileDownload = ReturnType<typeof sessionFileDownloads>
export function sessionFileDownloads(services: Services) {
  const downloads = new Map<string, number>()
  return (reply: FastifyReply, owner: Owner, targetId: string, sessionId: string, fileId: string) =>
    withRequestSignal(reply, async signal => {
      if (!sessionFileId(fileId)) throw new AppError('Invalid session file ID.')
      const user = owner.userId
      if ((downloads.get(user) ?? 0) >= 2 || [...downloads.values()].reduce((a, b) => a + b, 0) >= 4)
        throw new AppError('Too many file transfers. Try again shortly.', 429)
      downloads.set(user, (downloads.get(user) ?? 0) + 1)
      let released = false
      const release = () => {
        if (released) return
        released = true
        const count = (downloads.get(user) ?? 1) - 1
        if (count) downloads.set(user, count)
        else downloads.delete(user)
      }
      try {
        const context = await services.resolve(owner, targetId)
        const { file, bytes } = await services.files.read(context, sessionId, fileId, signal)
        if (!services.active(owner)) throw new AppError('Sign-in ended. Connect again.', 401)
        // Keep the slot while a slow client is still receiving the buffered file.
        reply.raw.once('close', release)
        return sendAttachment(reply, file, bytes)
      } catch (error) {
        release()
        throw error
      }
    })
}

export function sessionFileRoutes(app: FastifyInstance, services: Services, download: SessionFileDownload) {
  const files = services.files
  app.get('/api/terminal/files', (request, reply) =>
    withRequestSignal(reply, async signal => {
      const grant = terminalGrant(services, request)
      reply.header('Cache-Control', 'no-store')
      const result = await files.list(await services.resolve(grant.owner, grant.targetId), grant.sessionId, signal)
      if (!services.active(grant.owner)) throw new AppError('Sign-in ended. Connect again.', 401)
      return result
    }),
  )
  app.get<{ Params: { fileId: string } }>('/api/terminal/files/:fileId', (request, reply) => {
    const grant = terminalGrant(services, request)
    return download(reply, grant.owner, grant.targetId, grant.sessionId, request.params.fileId)
  })
  app.delete<{ Params: { fileId: string } }>('/api/terminal/files/:fileId', async (request, reply) => {
    const grant = terminalGrant(services, request)
    if (!sessionFileId(request.params.fileId)) throw new AppError('Invalid session file ID.')
    await files.remove(await services.resolve(grant.owner, grant.targetId), grant.sessionId, request.params.fileId)
    services.broker.filesChanged(grant)
    return reply.send({ ok: true })
  })
}
