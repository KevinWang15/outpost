import type { FastifyInstance } from 'fastify'
import type { Services } from '../services'
import type { TerminalQuery } from '../terminal/broker'

export function terminalRoutes(app: FastifyInstance, services: Services) {
  app.get<{ Querystring: TerminalQuery }>('/api/terminal', { websocket: true }, (socket, request) => {
    void services.broker.accept(socket, request.query)
  })
}
