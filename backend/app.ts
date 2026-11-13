import Fastify, { LogController } from 'fastify'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import staticFiles from '@fastify/static'
import cookies from '@fastify/cookie'
import websocket from '@fastify/websocket'
import type { Deployment, Owner } from './deployment'
import { Installations } from './installations'
import { SessionClient, type SessionService } from './sessions'
import { SessionFileClient } from './sessionFiles'
import { SoftwareClient, type SoftwareService } from './software'
import { targetResolver, type Services } from './services'
import { TerminalBroker } from './terminal/broker'
import { ConnectTokens } from './terminal/tokens'
import { sessionRoutes } from './routes/sessions'
import { terminalRoutes } from './routes/terminal'
import { sessionFileDownloads } from './routes/sessionFiles'
import { workspaceRoutes } from './routes/workspace'
import { pagePaths } from '../shared/pages'
import { pageHtml } from '../shared/pageHtml'
import { DesktopAccess } from './desktop-access'
import { desktopRoutes } from './routes/desktop'
import { ChatHub } from './chat/hub'
import { machineConnector, type ChatConnector } from './chat/links'
import { ChatServer } from './chat/socket'
import { ChatTokens } from './chat/tokens'
import { chatRoutes } from './routes/chat'
import { HistoryHub, type HistoryOptions } from './history/hub'
import { Machines } from './machines'
import historyToolDefinitions from '../shared/historyTools.json' with { type: 'json' }

export interface AppOptions {
  deployment: Deployment
  sessions?: SessionService
  software?: SoftwareService
  env?: NodeJS.ProcessEnv
  frontendRoot?: string
  logger?: boolean
  trustProxy?: string[]
  /** OpenSSH connection sharing; on by default except on Windows. */
  multiplex?: boolean
  /** How the server reaches chat hosts; tests connect to them directly. */
  chatConnector?: ChatConnector
  history?: HistoryOptions | false
}

export async function createApp(options: AppOptions) {
  const { deployment } = options
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    routerOptions: { maxParamLength: 1024 },
    bodyLimit: 128 * 1024,
    trustProxy: options.trustProxy ?? false,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
  })
  await app.register(cookies)
  // Allow JSON escaping of a 64 KiB input message, plus its control envelope.
  await app.register(websocket, { options: { maxPayload: 512 * 1024, perMessageDeflate: false } })

  const machines = new Machines(deployment.secret, options.env)
  const sessions = options.sessions ?? new SessionClient()
  const software = options.software ?? new SoftwareClient(options.env)
  const resolveTarget = targetResolver(deployment, machines, options.multiplex ?? true)
  const history =
    options.history === false ? null : new HistoryHub({ deployment, resolve: resolveTarget, ...options.history })
  const resolve = async (owner: Owner, targetId: string) => {
    const context = await resolveTarget(owner, targetId)
    history?.watch(owner)
    return context
  }
  const tokens = new ConnectTokens(deployment.secret)
  const desktop = await DesktopAccess.open(deployment)
  const active = (owner: Owner) => desktop.active(owner)
  const broker = new TerminalBroker({ tokens, active, sessions, resolve })
  const services: Services = {
    deployment,
    sessions,
    files: new SessionFileClient(),
    software,
    tokens,
    broker,
    machines,
    active,
    resolve,
    installations: new Installations(software),
    context: (request, targetId) => resolve(deployment.owner(request), targetId),
  }
  const hub = new ChatHub({
    deployment,
    resolve,
    files: services.files,
    list: async (context, signal) => (await sessions.list(context, signal)).sessions,
    connect: options.chatConnector ?? machineConnector(sessions),
  })
  // Agents' Outpost tool calls arrive on their machine's connection.
  const historyTools = new Set(historyToolDefinitions.map(tool => tool.name))
  machines.agent = async (owner, targetId, call) => {
    if (historyTools.has(call.tool)) {
      if (!history) throw new Error('Cross-machine history is turned off on this Outpost server.')
      return history.call(owner, call.tool, call.arguments)
    }
    return hub.agent(owner, { targetId, sessionId: call.session }, call.tool, call.arguments)
  }
  const chat = new ChatServer(hub, new ChatTokens(deployment.secret), services)
  await hub.start()
  await history?.start()
  app.addHook('preClose', async () => {
    machines.close()
    broker.close()
    chat.close()
    hub.close()
    await services.installations.close()
    await history?.close()
  })
  app.addHook('onClose', async () => {
    desktop.close()
    deployment.close()
  })

  app.addHook('onRequest', async (request, reply) => {
    const rejection = deployment.admits(request)
    if (rejection) return reply.code(403).send({ message: rejection })
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['x-outpost-request'] !== '1') {
      return reply.code(403).send({ message: 'Missing request header' })
    }
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('X-Frame-Options', 'DENY')
    if (deployment.mode === 'hosted') {
      const origin = deployment.origin(request)
      reply.header(
        'Content-Security-Policy',
        `default-src 'self'; connect-src 'self' ${origin.replace(/^http/, 'ws')}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`,
      )
    }
  })
  app.setErrorHandler((error, _request, reply) => {
    const problem = error as Error & { statusCode?: number }
    const status = problem.statusCode ?? 500
    if (status >= 500) app.log.error(problem)
    reply.code(status).send({
      message:
        deployment.mode === 'hosted' && status >= 500
          ? 'Something went wrong. Please try again later.'
          : problem.message,
    })
  })

  app.get('/health', async () => ({ status: 'ok' }))
  deployment.register(app)
  desktopRoutes(app, services, desktop)
  workspaceRoutes(app, services)
  sessionRoutes(app, services)
  const download = sessionFileDownloads(services)
  terminalRoutes(app, services, download)
  chatRoutes(app, services, chat, desktop, download)

  if (options.frontendRoot) {
    const html = await readFile(join(options.frontendRoot, 'index.html'), 'utf8')
    await app.register(staticFiles, { root: options.frontendRoot })
    const pages = new Set<string>(Object.values(pagePaths))
    app.setNotFoundHandler((request, reply) => {
      const pathname = request.url.split('?')[0]
      if (['GET', 'HEAD'].includes(request.method) && pages.has(pathname))
        return reply.type('text/html').send(pageHtml(html, pathname))
      return reply.code(404).send({ message: 'Not found' })
    })
  }
  return app
}
