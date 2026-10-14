import Fastify, { LogController } from 'fastify'
import staticFiles from '@fastify/static'
import cookies from '@fastify/cookie'
import websocket from '@fastify/websocket'
import type { Deployment } from './deployment'
import { Installations } from './installations'
import { SessionClient, type SessionService } from './sessions'
import { SoftwareClient, type SoftwareService } from './software'
import { targetResolver, type Services } from './services'
import { TerminalBroker } from './terminal/broker'
import { ConnectTokens } from './terminal/tokens'
import { sessionRoutes } from './routes/sessions'
import { terminalRoutes } from './routes/terminal'
import { workspaceRoutes } from './routes/workspace'
import { notificationSetupPath, terminalAppPath } from '../shared/terminals'

export interface AppOptions {
  deployment: Deployment
  sessions?: SessionService
  software?: SoftwareService
  env?: NodeJS.ProcessEnv
  frontendRoot?: string
  logger?: boolean
  trustProxy?: string[]
  /** OpenSSH connection sharing; on by default. */
  multiplex?: boolean
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
  // Image pastes travel over the terminal socket, up to 16 MB before base64.
  await app.register(websocket, { options: { maxPayload: 24 * 1024 * 1024, perMessageDeflate: false } })

  const sessions = options.sessions ?? new SessionClient(options.env)
  const software = options.software ?? new SoftwareClient(options.env)
  const resolve = targetResolver(deployment, options.multiplex ?? true)
  const tokens = new ConnectTokens(deployment.secret)
  const broker = new TerminalBroker({ tokens, deployment, sessions, resolve, env: options.env })
  const services: Services = {
    deployment,
    sessions,
    software,
    tokens,
    broker,
    resolve,
    installations: new Installations(software),
    context: (request, targetId) => resolve(deployment.owner(request), targetId),
  }
  app.addHook('preClose', async () => {
    broker.close()
    await services.installations.close()
  })
  app.addHook('onClose', async () => deployment.close())

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
  workspaceRoutes(app, services)
  sessionRoutes(app, services)
  terminalRoutes(app, services)

  if (options.frontendRoot) {
    await app.register(staticFiles, { root: options.frontendRoot })
    const pages = new Set([
      '/terminal',
      terminalAppPath,
      notificationSetupPath,
      '/login',
      '/signup',
      '/verify-email',
      '/forgot-password',
      '/reset-password',
    ])
    app.setNotFoundHandler((request, reply) => {
      if (['GET', 'HEAD'].includes(request.method) && pages.has(request.url.split('?')[0]))
        return reply.sendFile('index.html')
      return reply.code(404).send({ message: 'Not found' })
    })
  }
  return app
}
