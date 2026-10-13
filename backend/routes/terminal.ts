import type { FastifyInstance } from 'fastify'
import { connectorArchive, connectorVersion, installCommand, installScript } from '../connector'
import type { Services } from '../services'
import type { TerminalQuery } from '../terminal/broker'

export function terminalRoutes(app: FastifyInstance, services: Services) {
  // Authenticated by the connect token, so native clients need no browser cookie.
  app.get<{ Querystring: TerminalQuery }>('/api/terminal', { websocket: true }, (socket, request) => {
    void services.broker.accept(socket, request.query, { install: installCommand(services.deployment.origin(request)) })
  })
  app.get('/api/connector', async request => ({
    version: connectorVersion, install: installCommand(services.deployment.origin(request)),
  }))
  app.get('/connector/install.sh', async (request, reply) =>
    reply.type('text/x-shellscript; charset=utf-8').send(installScript(services.deployment.origin(request))))
  app.get('/connector/outpost-connector.pyz', async (_request, reply) =>
    reply.type('application/zip').header('Content-Disposition', 'attachment; filename="outpost-connector.pyz"').send(connectorArchive))
}
