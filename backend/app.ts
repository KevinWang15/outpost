import { randomUUID } from 'node:crypto'
import Fastify, { LogController, type FastifyRequest } from 'fastify'
import staticFiles from '@fastify/static'
import cookies from '@fastify/cookie'
import websocket from '@fastify/websocket'
import type { CodingSessionSearchInput, Target, TargetInput, TargetRequirements, SessionInput, SessionImageInput, SoftwareId } from '../shared/session-manager'
import { terminalApps, type DesktopLaunchInput } from '../shared/terminals'
import { AppError } from './errors'
import { targetBody, requirementsBody, sessionBody, imageBody, codingSessionSearchBody } from './schema'
import { TargetStore } from './store'
import { connectScript, supportedShells, sessionLaunchOptions, SessionClient, type SessionService } from './sessions'
import { quote } from './shell'
import { localDistribution, localEnvironment } from './local'
import { DesktopLauncher, type DesktopService } from './desktop'
import { SoftwareClient, type SoftwareService } from './software'
import { Installations } from './installations'
import { TargetLifecycle } from './target-lifecycle'
import { ConnectionTickets } from './connections'
import { withRequestSignal } from './request'
import { isLoopbackAddress } from '../shared/loopback'
import { Accounts } from './accounts'
import { TerminalKeys } from './terminal-keys'
import { WebTerminals, type TerminalOwner } from './web-terminals'

type Params = { targetId: string; sessionId: string }
const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host)

export async function createApp(options: {
  frontendRoot?: string; logger?: boolean; store?: TargetStore; service?: SessionService; desktop?: DesktopService; software?: SoftwareService; accounts?: Accounts; trustProxy?: string[]; terminalKeys?: TerminalKeys; terminalGraceMs?: number
} = {}) {
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    routerOptions: { maxParamLength: 1024 },
    bodyLimit: 128 * 1024,
    trustProxy: options.trustProxy ?? false,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
  })
  await app.register(cookies)
  await app.register(websocket, { options: { maxPayload: 32 * 1024, perMessageDeflate: false } })
  app.decorateRequest('account', null)
  const accounts = options.accounts
  const store = options.store ?? new TargetStore()
  const service = options.service ?? new SessionClient(process.env, Boolean(accounts))
  const desktop = options.desktop ?? new DesktopLauncher()
  const software = options.software ?? new SoftwareClient(process.env, Boolean(accounts))
  const installations = new Installations(software)
  const targets = new TargetLifecycle(store, installations)
  const workspaces = new Map<string, { store: TargetStore; targets: TargetLifecycle }>()
  function userWorkspace(userId: string) {
    let context = workspaces.get(userId)
    if (!context) {
      const userStore = accounts!.targetStore(userId)
      context = { store: userStore, targets: new TargetLifecycle(userStore, installations) }
      workspaces.set(userId, context)
    }
    return context
  }
  const workspace = (request: FastifyRequest) => accounts ? userWorkspace(request.account!.user.id) : { store, targets }
  const terminalOwner = (request: FastifyRequest): TerminalOwner => accounts ? { userId: request.account!.user.id, authSessionId: request.account!.id } : { userId: 'local', authSessionId: 'local' }
  const terminalKeys = options.terminalKeys ?? new TerminalKeys(accounts?.store.directory ?? store.directory)
  const webTerminals = new WebTerminals(terminalKeys, owner => !accounts || Boolean(accounts.store.ticketSession(owner.userId, owner.authSessionId)), options.terminalGraceMs)
  app.addHook('preClose', async () => { webTerminals.close() })
  app.addHook('preClose', () => installations.close())
  const tickets = new ConnectionTickets(accounts ? accounts.store.secret() : await store.secret())
  if (accounts) {
    const cleanup = setInterval(() => accounts.store.cleanup(), 60 * 60_000).unref()
    app.addHook('onClose', async () => { clearInterval(cleanup); accounts.close() })
  }

  app.addHook('onRequest', async (request, reply) => {
    // Local mode and simulated development email remain restricted to loopback.
    if ((!accounts || !accounts.production) && !isLoopbackAddress(request.ip)) {
      return reply.code(403).send({ message: 'Outpost only accepts connections from loopback. Use an SSH localhost tunnel.' })
    }
    let host = ''
    try { host = new URL(`http://${request.headers.host}`).hostname } catch { /* rejected below */ }
    if (accounts ? !accounts.allowsHost(request.headers.host ?? '') : !loopback(host)) return reply.code(403).send({ message: 'Use the configured Outpost address.' })
    if (request.headers.origin) {
      let allowed = false
      try { allowed = accounts ? accounts.allowsOrigin(request.headers.origin) : loopback(new URL(request.headers.origin).hostname) } catch { /* rejected below */ }
      if (!allowed) return reply.code(403).send({ message: 'Cross-origin requests are not allowed' })
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['x-outpost-request'] !== '1') {
      return reply.code(403).send({ message: 'Missing request header' })
    }
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('X-Frame-Options', 'DENY')
    if (accounts?.production) reply.header('Content-Security-Policy', `default-src 'self'; connect-src 'self' ${accounts.publicUrl.origin.replace('https:', 'wss:')}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`)
    const path = request.routeOptions.url ?? request.url.split('?')[0]
    if (accounts && path.startsWith('/api/') && !path.startsWith('/api/auth/') && !path.startsWith('/api/connect/')) accounts.authenticate(request)
  })
  app.setErrorHandler((error, _request, reply) => {
    const problem = error as Error & { statusCode?: number }
    const status = problem.statusCode ?? 500
    if (status >= 500) app.log.error(problem)
    reply.code(status).send({ message: accounts && status >= 500 ? 'Something went wrong. Please try again later.' : problem.message })
  })
  app.get('/health', async () => ({ status: 'ok' }))
  if (accounts) accounts.register(app)
  else app.get('/api/auth/session', async () => ({ mode: 'local', user: null }))
  app.get('/api/environment', async () => accounts ? { platform: 'hosted', supported: false, usesWsl: false } : localEnvironment())
  app.get('/api/targets', async request => workspace(request).store.list())
  app.post<{ Body: TargetInput }>('/api/targets', { schema: { body: targetBody } }, async (request, reply) => {
    const target: Target = { ...request.body, name: request.body.name.trim(), id: randomUUID(), createdAt: new Date().toISOString() }
    if (accounts && target.kind === 'local') throw new AppError('Hosted workspaces support SSH targets. Local targets are available in local mode.', 400)
    if (target.kind === 'local') {
      const distribution = await localDistribution(target.distribution)
      if (distribution) target.distribution = distribution
    }
    await workspace(request).store.add(target)
    return reply.code(201).send(target)
  })
  app.patch<{ Params: Params; Body: TargetRequirements }>('/api/targets/:targetId/requirements', { schema: { body: requirementsBody } }, async request =>
    workspace(request).store.updateRequirements(request.params.targetId, request.body))
  app.get<{ Params: Params }>('/api/targets/:targetId/software', async (request, reply) =>
    withRequestSignal(reply, async signal => {
      const target = await workspace(request).store.get(request.params.targetId)
      const report = await software.inspect(target, signal)
      await workspace(request).store.updateEnvironment(target.id, report.environment)
      return { ...report, installation: installations.latest(target.id) }
    }))
  type SoftwareParams = Params & { softwareId: SoftwareId }
  app.get<{ Params: SoftwareParams }>('/api/targets/:targetId/software/:softwareId/script', async (request, reply) =>
    withRequestSignal(reply, async signal => {
      const target = await workspace(request).store.get(request.params.targetId)
      return software.plan(target, request.params.softwareId, signal)
    }))
  app.post<{ Params: Params; Body: { softwareId: SoftwareId; script: string } }>('/api/targets/:targetId/installations', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['softwareId', 'script'],
      properties: {
        softwareId: { enum: ['bash', 'python3', 'tmux', 'dtach', 'lsof', 'codex', 'kimi', 'claude'] },
        script: { type: 'string', minLength: 1, maxLength: 64 * 1024, pattern: '^[^\\u0000]+$' },
      },
    } },
  }, async (request, reply) => {
    const installation = await workspace(request).targets.install(request.params.targetId, request.body.softwareId, request.body.script)
    return reply.code(202).send(installation)
  })
  app.get<{ Params: Params }>('/api/targets/:targetId/installations', async request => {
    await workspace(request).store.get(request.params.targetId)
    return { installation: installations.latest(request.params.targetId) }
  })
  app.get<{ Params: Params & { installationId: string } }>('/api/targets/:targetId/installations/:installationId/events', async (request, reply) => {
    await workspace(request).store.get(request.params.targetId)
    reply.header('X-Accel-Buffering', 'no')
    return reply.type('application/x-ndjson; charset=utf-8').send(installations.events(request.params.targetId, request.params.installationId))
  })
  app.delete<{ Params: Params }>('/api/targets/:targetId', async (request, reply) => {
    const owner = terminalOwner(request)
    await webTerminals.exclusive(owner, request.params.targetId, async () => {
      await workspace(request).targets.remove(request.params.targetId)
      webTerminals.closeTarget(owner, request.params.targetId)
      await terminalKeys.remove(owner.userId, request.params.targetId)
    })
    return reply.code(204).send()
  })
  app.get<{ Params: Params }>('/api/targets/:targetId/sessions', async (request, reply) =>
    withRequestSignal(reply, async signal => service.list(await workspace(request).store.get(request.params.targetId), signal)))
  app.get<{ Params: Params }>('/api/targets/:targetId/sessions/:sessionId', async (request, reply) =>
    withRequestSignal(reply, async signal => service.get(await workspace(request).store.get(request.params.targetId), request.params.sessionId, signal)))
  app.post<{ Params: Params; Body: CodingSessionSearchInput }>('/api/targets/:targetId/coding-sessions/search', {
    schema: { body: codingSessionSearchBody },
  }, async (request, reply) => withRequestSignal(reply, async signal =>
    service.search(await workspace(request).store.get(request.params.targetId), request.body, signal)))
  app.get<{ Params: Params; Querystring: { path: string } }>('/api/targets/:targetId/directories', {
    schema: { querystring: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: { path: { type: 'string', maxLength: 4096, pattern: '^(|~|(?:~/|/)[^\\u0000-\\u001f\\u007f]*)$' } },
    } },
  }, async (request, reply) =>
    withRequestSignal(reply, async signal => {
      const target = await workspace(request).store.get(request.params.targetId)
      return service.directories(target, request.query.path, signal)
    }))
  app.post<{ Params: Params; Body: SessionInput }>('/api/targets/:targetId/sessions', {
    schema: { body: sessionBody },
  }, async (request, reply) => {
    const target = await workspace(request).store.get(request.params.targetId)
    if (!target.tools.includes(request.body.tool)) throw new AppError('Select this coding tool in Required Software before creating a session.', 400)
    if (!target.backends.includes(request.body.backend)) throw new AppError('Select this session backend in Required Software before creating a session.', 400)
    sessionLaunchOptions(request.body)
    return reply.code(201).send(await service.create(target, request.body))
  })
  app.delete<{ Params: Params }>('/api/targets/:targetId/sessions/:sessionId', async (request, reply) => {
    const owner = terminalOwner(request)
    await webTerminals.exclusive(owner, request.params.targetId, async () => {
      await service.remove(await workspace(request).store.get(request.params.targetId), request.params.sessionId)
      webTerminals.closeTarget(owner, request.params.targetId, request.params.sessionId)
    })
    return reply.code(204).send()
  })
  app.post<{ Params: Params }>('/api/targets/:targetId/sessions/:sessionId/terminate', async request => {
    const owner = terminalOwner(request)
    return webTerminals.exclusive(owner, request.params.targetId, async () => {
      const session = await service.terminate(await workspace(request).store.get(request.params.targetId), request.params.sessionId)
      webTerminals.closeTarget(owner, request.params.targetId, request.params.sessionId)
      return session
    })
  })
  const sshTarget = async (request: FastifyRequest<{ Params: Params }>) => {
    const target = await workspace(request).store.get(request.params.targetId)
    if (target.kind !== 'ssh') throw new AppError('Web terminals are available for SSH targets.', 400)
    return target
  }
  app.get<{ Params: Params }>('/api/targets/:targetId/terminal-key', async request => {
    await sshTarget(request)
    return terminalKeys.status(terminalOwner(request).userId, request.params.targetId)
  })
  app.put<{ Params: Params; Body: { privateKey: string; passphrase?: string } }>('/api/targets/:targetId/terminal-key', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['privateKey'], properties: {
      privateKey: { type: 'string', minLength: 1, maxLength: 64 * 1024 }, passphrase: { type: 'string', maxLength: 1024 },
    } } },
  }, async request => {
    const owner = terminalOwner(request)
    return webTerminals.exclusive(owner, request.params.targetId, async () => {
      await sshTarget(request)
      const key = await terminalKeys.upload(owner.userId, request.params.targetId, request.body.privateKey, request.body.passphrase)
      webTerminals.closeTarget(owner, request.params.targetId)
      return { encryptionAvailable: true, key }
    })
  })
  app.delete<{ Params: Params }>('/api/targets/:targetId/terminal-key', async (request, reply) => {
    const owner = terminalOwner(request)
    await webTerminals.exclusive(owner, request.params.targetId, async () => {
      await sshTarget(request)
      webTerminals.closeTarget(owner, request.params.targetId)
      await terminalKeys.remove(owner.userId, request.params.targetId)
    })
    return reply.code(204).send()
  })
  app.post<{ Params: Params; Body: { cols: number; rows: number } }>('/api/targets/:targetId/sessions/:sessionId/web-terminal', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['cols', 'rows'], properties: {
      cols: { type: 'integer', minimum: 20, maximum: 300 }, rows: { type: 'integer', minimum: 5, maximum: 120 },
    } } },
  }, async request => {
    const owner = terminalOwner(request)
    return webTerminals.exclusive(owner, request.params.targetId, async () => {
      const target = await sshTarget(request)
      await service.get(target, request.params.sessionId)
      return webTerminals.start(owner, target, request.params.sessionId, request.body.cols, request.body.rows)
    })
  })
  app.delete<{ Params: { terminalId: string } }>('/api/web-terminals/:terminalId', async (request, reply) => {
    webTerminals.disconnect(terminalOwner(request), request.params.terminalId)
    return reply.code(204).send()
  })
  app.get<{ Params: { terminalId: string } }>('/api/web-terminals/:terminalId/socket', {
    websocket: true,
    preValidation: async request => {
      if (!request.headers.origin) throw new AppError('A browser origin is required.', 403)
      // The global origin guard validates hosted origins; local mode also requires the exact host/port.
      if (!accounts && new URL(request.headers.origin).host !== request.headers.host) throw new AppError('Cross-origin terminal connections are not allowed.', 403)
      webTerminals.get(terminalOwner(request), request.params.terminalId)
    },
  }, (socket, request) => webTerminals.attach(terminalOwner(request), request.params.terminalId, socket))
  app.post<{ Params: Params; Body: { completionId: string } }>('/api/targets/:targetId/sessions/:sessionId/acknowledge', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['completionId'],
      properties: { completionId: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
    } },
  }, async request => service.acknowledge(await workspace(request).store.get(request.params.targetId), request.params.sessionId, request.body.completionId))
  app.post<{ Params: Params; Body: SessionImageInput }>('/api/targets/:targetId/sessions/:sessionId/image', {
    bodyLimit: 24 * 1024 * 1024,
    schema: { body: imageBody },
  }, async request => service.pasteImage(await workspace(request).store.get(request.params.targetId), request.params.sessionId, request.body))
  app.post<{ Params: Params }>('/api/targets/:targetId/sessions/:sessionId/connect', async (request, reply) => withRequestSignal(reply, async signal => {
    const target = await workspace(request).store.get(request.params.targetId)
    await service.get(target, request.params.sessionId, signal)
    const { tokens, expiresAt } = tickets.issue(target.id, request.params.sessionId, accounts ? { userId: request.account!.user.id, authSessionId: request.account!.id } : undefined)
    const link = (shell: keyof typeof tokens) => `${accounts?.publicUrl.origin ?? `http://${request.headers.host}`}/api/connect/${tokens[shell]}`
    const powershell = `& ([scriptblock]::Create((Invoke-RestMethod -Uri '${link('powershell')}' -ErrorAction Stop)))`
    const commands = {
      bash: `curl -fsS ${quote(link('bash'))} | bash`,
      powershell,
      cmd: `powershell.exe -NoLogo -NoProfile -Command "${powershell}"`,
    }
    return {
      commands: Object.fromEntries(supportedShells(target).map(shell => [shell, commands[shell]])),
      expiresAt,
      desktop: accounts ? { os: null, terminals: [], recommendedId: null } : await desktop.available(),
      ...(accounts ? { hosted: true } : {}),
    }
  }))
  app.post<{ Params: Params; Body: DesktopLaunchInput }>('/api/targets/:targetId/sessions/:sessionId/launch', {
    schema: { body: {
      type: 'object', additionalProperties: false,
      not: { required: ['terminalId', 'preferences'] },
      properties: {
        terminalId: { type: 'string', enum: terminalApps.map(app => app.id) },
        preferences: {
          type: 'object', additionalProperties: false,
          properties: Object.fromEntries(['macos', 'windows', 'linux'].map(os => [os, {
            type: 'string', enum: terminalApps.filter(app => app.os === os).map(app => app.id),
          }])),
        },
      },
    } },
  }, async request => {
    if (accounts) throw new AppError('Desktop terminal launch is available in local mode. In hosted mode, choose Launch with web terminal from the session menu or copy a connection command.', 403)
    const target = await workspace(request).store.get(request.params.targetId)
    await service.get(target, request.params.sessionId)
    return desktop.launch(shell => connectScript(target, request.params.sessionId, shell), request.body)
  })
  app.get<{ Params: { token: string } }>('/api/connect/:token', async (request, reply) => {
    const ticket = tickets.verify(request.params.token)
    if (accounts && (!ticket.userId || !ticket.authSessionId || !accounts.store.ticketSession(ticket.userId, ticket.authSessionId))) throw new AppError('Connection link expired or sign-in ended. Sign in and generate a new command.', 403)
    const targetStore = accounts ? userWorkspace(ticket.userId!).store : store
    const target = await targetStore.get(ticket.targetId)
    return reply.type(ticket.shell === 'bash' ? 'text/x-shellscript; charset=utf-8' : 'text/plain; charset=utf-8')
      .send(connectScript(target, ticket.sessionId, ticket.shell))
  })
  if (options.frontendRoot) {
    await app.register(staticFiles, { root: options.frontendRoot })
    const authPages = new Set(['/login', '/signup', '/verify-email', '/forgot-password', '/reset-password'])
    app.setNotFoundHandler((request, reply) => {
      if (['GET', 'HEAD'].includes(request.method) && authPages.has(request.url.split('?')[0])) return reply.sendFile('index.html')
      return reply.code(404).send({ message: 'Not found' })
    })
  }
  return app
}
