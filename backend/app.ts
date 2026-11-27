import { createReadStream } from 'node:fs'
import { MachineAssets } from './machineAssets'
import { machineInstaller } from './machineInstaller'
import Fastify, { LogController } from 'fastify'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
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
import { enrollmentRoutes } from './enrollment'
import { workspaceRoutes } from './routes/workspace'
import { pagePaths } from '../shared/pages'
import { isStandaloneAgentTool, SSH_BRIDGE_ENABLED } from '../shared/sshBridgeProtocol'
import { DesktopAccess } from './desktop-access'
import { desktopRoutes } from './routes/desktop'
import { ChatHub } from './chat/hub'
import { machineConnector, type ChatConnector } from './chat/links'
import { ChatServer } from './chat/socket'
import { ChatTokens } from './chat/tokens'
import { chatRoutes } from './routes/chat'
import { HistoryHub, type HistoryOptions } from './history/hub'
import { MachineConnectionError, Machines } from './machines'
import { ActivityLog, logViewerMount } from './logs/activity'
import { MachineEventLog } from './logs/machines'
import { logRoutes } from './routes/logs'
import historyToolDefinitions from '../shared/historyTools.json' with { type: 'json' }

interface AppOptions {
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
  const log = new ActivityLog(deployment, header => app.parseCookie(header))
  const sessions = options.sessions ?? new SessionClient()
  const assets = new MachineAssets(deployment.directory, options.env)
  const software = options.software ?? new SoftwareClient(assets, options.env)
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
  const broker = new TerminalBroker({
    tokens,
    active,
    sessions,
    resolve,
    log: (owner, input) => log.record(owner, input),
  })
  const services: Services = {
    deployment,
    sessions,
    files: new SessionFileClient(),
    software,
    tokens,
    broker,
    machines,
    log,
    active,
    resolve,
    installations: new Installations(software, (owner, input) => log.record(owner, input)),
    context: (request, targetId) => resolve(deployment.owner(request), targetId),
  }
  const hub = new ChatHub({
    deployment,
    resolve,
    files: services.files,
    terminals: sessions,
    list: async (context, signal) => (await sessions.list(context, signal)).sessions,
    connect: options.chatConnector ?? machineConnector(sessions),
    log: (owner, input) => log.record(owner, input),
  })
  const machineEvents = new MachineEventLog({
    deployment,
    resolve: resolveTarget,
    list: async context => (await sessions.list(context)).sessions,
    log,
  })
  const historyTools = new Set(historyToolDefinitions.map(tool => tool.name))
  machines.configure({
    events: (owner, targetId) => void machineEvents.read(owner, targetId),
    // Agents' Outpost tool calls arrive on their machine's connection.
    agent: async (owner, targetId, call) => {
      if (call.session === null && (!SSH_BRIDGE_ENABLED || !isStandaloneAgentTool(call.tool)))
        throw new Error('This tool requires a managed Outpost session.')
      if (historyTools.has(call.tool)) {
        if (!history) throw new Error('Cross-machine history is turned off on this Outpost server.')
        return history.call(owner, call.tool, call.arguments)
      }
      return hub.agent(owner, { targetId, sessionId: call.session ?? '' }, call.tool, call.arguments)
    },
  })
  const chat = new ChatServer(hub, new ChatTokens(deployment.secret), services)
  await hub.start()
  await history?.start()
  await log.start()
  machineEvents.start()
  // The log viewer's live updates share the server with Outpost's own sockets:
  // each upgrade goes to the viewer or to Fastify, never both.
  const upgrades = app.server.listeners('upgrade') as ((...args: unknown[]) => void)[]
  app.server.removeAllListeners('upgrade')
  app.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!log.handlesUpgrade(request, socket, head))
      for (const listener of upgrades) listener.call(app.server, request, socket, head)
  })
  app.addHook('preClose', async () => {
    machines.close()
    broker.close()
    chat.close()
    hub.close()
    await services.installations.close()
    await history?.close()
    machineEvents.close()
    await log.close()
  })
  app.addHook('onClose', async () => {
    desktop.close()
    deployment.close()
  })

  app.addHook('onRequest', async (request, reply) => {
    const rejection = deployment.admits(request)
    if (rejection) return reply.code(403).send({ message: rejection })
    // The log viewer's own pages cannot send Outpost's header; they need its other checks.
    const viewer = request.url === logViewerMount || request.url.startsWith(`${logViewerMount}/`)
    if (
      !viewer &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.headers['x-outpost-request'] !== '1'
    ) {
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
    let message = problem.message
    if (deployment.mode === 'hosted' && status >= 500)
      message =
        problem instanceof MachineConnectionError
          ? problem.publicMessage
          : 'Something went wrong. Please try again later.'
    reply.code(status).send({ message })
  })

  app.get('/health', async () => ({ status: 'ok' }))
  app.get('/api/install/machine.sh', async (_req, reply) =>
    reply
      .type('text/x-shellscript; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="machine.sh"')
      .send(machineInstaller()),
  )
  app.get<{ Params: { platform: string } }>('/api/install/:platform/binary', async (req, reply) => {
    const asset = await assets.service(req.params.platform)
    return reply.type('application/octet-stream').send(createReadStream(asset.path))
  })
  app.get<{ Params: { platform: string } }>('/api/install/:platform/sha256', async (req, reply) =>
    reply.type('text/plain').send((await assets.service(req.params.platform)).sha256 + '\n'),
  )
  deployment.register(app)
  desktopRoutes(app, services, desktop)
  workspaceRoutes(app, services, enrollmentRoutes(app, services), async (owner, targetId) => {
    await hub.targetDeleted(owner, targetId)
    await machineEvents.forgetTarget(owner, targetId)
    history?.forgetTarget(owner, targetId)
  })
  sessionRoutes(app, services, hub)
  terminalRoutes(app, services)
  chatRoutes(app, services, chat)
  logRoutes(app, services)
  await app.register(async viewer => {
    // The viewer reads its own request bodies.
    viewer.removeAllContentTypeParsers()
    viewer.addContentTypeParser('*', (_request, _payload, done) => done(null))
    viewer.all(logViewerMount, (request, reply) => log.serve(request, reply))
    viewer.all(`${logViewerMount}/*`, (request, reply) => log.serve(request, reply))
  })

  if (options.frontendRoot) {
    const html = await readFile(join(options.frontendRoot, 'index.html'), 'utf8')
    await app.register(staticFiles, { root: options.frontendRoot })
    const pages = new Set<string>(Object.values(pagePaths))
    app.setNotFoundHandler((request, reply) => {
      const pathname = request.url.split('?')[0]
      const isGuidePage = /^\/guide(?:\/[a-z0-9-]+)*\/?$/.test(pathname)
      if (['GET', 'HEAD'].includes(request.method) && (pages.has(pathname) || isGuidePage))
        return reply.type('text/html').send(html)
      return reply.code(404).send({ message: 'Not found' })
    })
  }
  return app
}
