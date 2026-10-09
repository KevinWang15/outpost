import type { FastifyInstance, FastifyRequest } from 'fastify'
import { signalTypePattern } from '../shared/signals'
import { AppError } from './errors'
import type { SignalOwner, Signals } from './signals'

export function signalRoutes(app: FastifyInstance, signals: Signals, owner: (request: FastifyRequest) => SignalOwner) {
  const id = { type: 'string', pattern: '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$' }
  app.get<{ Querystring: { id: string; types: string } }>('/api/signals/events', {
    schema: { querystring: { type: 'object', additionalProperties: false, required: ['id', 'types'], properties: {
      id, types: { type: 'string', minLength: 1, maxLength: 800 },
    } } },
  }, (request, reply) => {
    const types = request.query.types.split(',')
    if (types.length > 16 || types.some(type => !signalTypePattern.test(type) || type.length > 80)) throw new AppError('Invalid signal listener types.', 400)
    const stop = signals.listen(request.query.id, owner(request), types, event => {
      if (reply.raw.destroyed || reply.raw.writableEnded || reply.raw.writableLength > 64 * 1024) throw new AppError('Signal listener disconnected.', 503)
      reply.raw.write(`event: signal\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)
    }, () => { clearInterval(heartbeat); reply.raw.end() })
    reply.hijack()
    for (const [key, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(key, value)
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' })
    reply.raw.write(': connected\n\n')
    const heartbeat = setInterval(() => {
      if (reply.raw.writableLength > 64 * 1024) reply.raw.destroy()
      else reply.raw.write(': keepalive\n\n')
    }, 15_000).unref()
    reply.raw.once('close', () => { clearInterval(heartbeat); stop() })
  })
  app.post<{ Params: { id: string }; Body: { focused: boolean; visible: boolean } }>('/api/signals/listeners/:id/activity', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id } },
      body: { type: 'object', additionalProperties: false, required: ['focused', 'visible'], properties: { focused: { type: 'boolean' }, visible: { type: 'boolean' } } },
    },
  }, async (request, reply) => {
    signals.activity(request.params.id, owner(request), request.body.focused, request.body.visible)
    return reply.code(204).send()
  })
}
