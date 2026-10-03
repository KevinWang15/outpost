import { randomUUID } from 'node:crypto'
import Fastify, { LogController } from 'fastify'
import staticFiles from '@fastify/static'
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

type Params = { targetId: string; sessionId: string }
const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host)

export async function createApp(options: {
  frontendRoot?: string; logger?: boolean; store?: TargetStore; service?: SessionService; desktop?: DesktopService; software?: SoftwareService
} = {}) {
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    routerOptions: { maxParamLength: 1024 },
    bodyLimit: 128 * 1024,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
  })
  const store = options.store ?? new TargetStore()
  const service = options.service ?? new SessionClient()
  const desktop = options.desktop ?? new DesktopLauncher()
  const software = options.software ?? new SoftwareClient()
  const installations = new Installations(software)
  const targets = new TargetLifecycle(store, installations)
  app.addHook('preClose', () => installations.close())
  const tickets = new ConnectionTickets(await store.secret())

  app.addHook('onRequest', async (request, reply) => {
    // This app holds access to the user's SSH identity: restrict browser access to loopback.
    if (!isLoopbackAddress(request.ip)) {
      return reply.code(403).send({ message: 'Outpost only accepts connections from loopback. Use an SSH localhost tunnel.' })
    }
    let host = ''
    try { host = new URL(`http://${request.headers.host}`).hostname } catch { /* rejected below */ }
    if (!loopback(host)) return reply.code(403).send({ message: 'Use the manager through localhost or an SSH localhost tunnel.' })
    if (request.headers.origin) {
      let allowed = false
      try { allowed = loopback(new URL(request.headers.origin).hostname) } catch { /* rejected below */ }
      if (!allowed) return reply.code(403).send({ message: 'Cross-origin requests are not allowed' })
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['x-outpost-request'] !== '1') {
      return reply.code(403).send({ message: 'Missing request header' })
    }
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
  })
  app.setErrorHandler((error, _request, reply) => {
    const problem = error as Error & { statusCode?: number }
    reply.code(problem.statusCode ?? 500).send({ message: problem.message })
  })
  app.get('/health', async () => ({ status: 'ok' }))
  app.get('/api/environment', async () => localEnvironment())
  app.get('/api/targets', async () => store.list())
  app.post<{ Body: TargetInput }>('/api/targets', { schema: { body: targetBody } }, async (request, reply) => {
    const target: Target = { ...request.body, name: request.body.name.trim(), id: randomUUID(), createdAt: new Date().toISOString() }
    if (target.kind === 'local') {
      const distribution = await localDistribution(target.distribution)
      if (distribution) target.distribution = distribution
    }
    await store.add(target)
    return reply.code(201).send(target)
  })
  app.patch<{ Params: Params; Body: TargetRequirements }>('/api/targets/:targetId/requirements', { schema: { body: requirementsBody } }, async request =>
    store.updateRequirements(request.params.targetId, request.body))
  app.get<{ Params: Params }>('/api/targets/:targetId/software', async (request, reply) =>
    withRequestSignal(reply, async signal => {
      const target = await store.get(request.params.targetId)
      const report = await software.inspect(target, signal)
      await store.updateEnvironment(target.id, report.environment)
      return { ...report, installation: installations.latest(target.id) }
    }))
  type SoftwareParams = Params & { softwareId: SoftwareId }
  app.get<{ Params: SoftwareParams }>('/api/targets/:targetId/software/:softwareId/script', async (request, reply) =>
    withRequestSignal(reply, async signal => {
      const target = await store.get(request.params.targetId)
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
    const installation = await targets.install(request.params.targetId, request.body.softwareId, request.body.script)
    return reply.code(202).send(installation)
  })
  app.get<{ Params: Params }>('/api/targets/:targetId/installations', async request => {
    await store.get(request.params.targetId)
    return { installation: installations.latest(request.params.targetId) }
  })
  app.get<{ Params: Params & { installationId: string } }>('/api/targets/:targetId/installations/:installationId/events', async (request, reply) => {
    await store.get(request.params.targetId)
    reply.header('X-Accel-Buffering', 'no')
    return reply.type('application/x-ndjson; charset=utf-8').send(installations.events(request.params.targetId, request.params.installationId))
  })
  app.delete<{ Params: Params }>('/api/targets/:targetId', async (request, reply) => {
    await targets.remove(request.params.targetId)
    return reply.code(204).send()
  })
  app.get<{ Params: Params }>('/api/targets/:targetId/sessions', async (request, reply) =>
    withRequestSignal(reply, async signal => service.list(await store.get(request.params.targetId), signal)))
  app.get<{ Params: Params }>('/api/targets/:targetId/sessions/:sessionId', async (request, reply) =>
    withRequestSignal(reply, async signal => service.get(await store.get(request.params.targetId), request.params.sessionId, signal)))
  app.post<{ Params: Params; Body: CodingSessionSearchInput }>('/api/targets/:targetId/coding-sessions/search', {
    schema: { body: codingSessionSearchBody },
  }, async (request, reply) => withRequestSignal(reply, async signal =>
    service.search(await store.get(request.params.targetId), request.body, signal)))
  app.get<{ Params: Params; Querystring: { path: string } }>('/api/targets/:targetId/directories', {
    schema: { querystring: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: { path: { type: 'string', maxLength: 4096, pattern: '^(|~|(?:~/|/)[^\\u0000-\\u001f\\u007f]*)$' } },
    } },
  }, async (request, reply) =>
    withRequestSignal(reply, async signal => {
      const target = await store.get(request.params.targetId)
      return service.directories(target, request.query.path, signal)
    }))
  app.post<{ Params: Params; Body: SessionInput }>('/api/targets/:targetId/sessions', {
    schema: { body: sessionBody },
  }, async (request, reply) => {
    const target = await store.get(request.params.targetId)
    if (!target.tools.includes(request.body.tool)) throw new AppError('Select this coding tool in Required Software before creating a session.', 400)
    if (!target.backends.includes(request.body.backend)) throw new AppError('Select this session backend in Required Software before creating a session.', 400)
    sessionLaunchOptions(request.body)
    return reply.code(201).send(await service.create(target, request.body))
  })
  app.delete<{ Params: Params }>('/api/targets/:targetId/sessions/:sessionId', async (request, reply) => {
    await service.remove(await store.get(request.params.targetId), request.params.sessionId)
    return reply.code(204).send()
  })
  app.post<{ Params: Params }>('/api/targets/:targetId/sessions/:sessionId/terminate', async request =>
    service.terminate(await store.get(request.params.targetId), request.params.sessionId))
  app.post<{ Params: Params; Body: { completionId: string } }>('/api/targets/:targetId/sessions/:sessionId/acknowledge', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['completionId'],
      properties: { completionId: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
    } },
  }, async request => service.acknowledge(await store.get(request.params.targetId), request.params.sessionId, request.body.completionId))
  app.post<{ Params: Params; Body: SessionImageInput }>('/api/targets/:targetId/sessions/:sessionId/image', {
    bodyLimit: 24 * 1024 * 1024,
    schema: { body: imageBody },
  }, async request => service.pasteImage(await store.get(request.params.targetId), request.params.sessionId, request.body))
  app.post<{ Params: Params }>('/api/targets/:targetId/sessions/:sessionId/connect', async (request, reply) => withRequestSignal(reply, async signal => {
    const target = await store.get(request.params.targetId)
    await service.get(target, request.params.sessionId, signal)
    const { tokens, expiresAt } = tickets.issue(target.id, request.params.sessionId)
    const link = (shell: keyof typeof tokens) => `http://${request.headers.host}/api/connect/${tokens[shell]}`
    const powershell = `& ([scriptblock]::Create((Invoke-RestMethod -Uri '${link('powershell')}' -ErrorAction Stop)))`
    const commands = {
      bash: `curl -fsS ${quote(link('bash'))} | bash`,
      powershell,
      cmd: `powershell.exe -NoLogo -NoProfile -Command "${powershell}"`,
    }
    return {
      commands: Object.fromEntries(supportedShells(target).map(shell => [shell, commands[shell]])),
      expiresAt,
      desktop: await desktop.available(),
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
    const target = await store.get(request.params.targetId)
    await service.get(target, request.params.sessionId)
    return desktop.launch(shell => connectScript(target, request.params.sessionId, shell), request.body)
  })
  app.get<{ Params: { token: string } }>('/api/connect/:token', async (request, reply) => {
    const ticket = tickets.verify(request.params.token)
    const target = await store.get(ticket.targetId)
    return reply.type(ticket.shell === 'bash' ? 'text/x-shellscript; charset=utf-8' : 'text/plain; charset=utf-8')
      .send(connectScript(target, ticket.sessionId, ticket.shell))
  })
  if (options.frontendRoot) await app.register(staticFiles, { root: options.frontendRoot })
  return app
}
