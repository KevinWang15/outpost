// Session operations and activity logging shared by REST routes, Desktop API, and Chat WS.
import { createHmac } from 'node:crypto'
import type { DesktopSession } from '../shared/desktopAuth'
import {
  coreSoftware,
  type Session,
  type SessionForkInput,
  type SessionInput,
  type SessionUpdate,
} from '../shared/model'
import type { ChatHub } from './chat/hub'
import { AppError } from './errors'
import type { Services } from './services'
import { launchSize, type TargetContext } from './sessions'

const machine = (context: TargetContext) => ({ id: context.target.id, name: context.target.name })
const named = (session: Session) => ({ id: session.id, name: session.name })

/** What an edit changed, in words. */
function describeChanges(update: SessionUpdate) {
  return [
    update.name !== undefined && 'name',
    update.tool !== undefined && 'coding tool',
    update.rootDir !== undefined && 'directory',
    update.conversation !== undefined && 'conversation',
    update.instructions !== undefined && 'instructions',
    update.model !== undefined && 'model',
    update.mode !== undefined && 'mode',
    update.mcpServers !== undefined && 'MCP servers',
    update.args !== undefined && 'arguments',
    update.env !== undefined && 'environment',
    update.delivery !== undefined && 'message delivery',
  ].filter(Boolean) as string[]
}

// The machine commits this identity with the session, across retries and routes.
export function sessionCreationKey(services: Services, userId: string, targetId: string, requestId?: string) {
  return requestId
    ? createHmac('sha256', services.deployment.secret)
        .update(JSON.stringify([userId, targetId, requestId]))
        .digest('hex')
    : undefined
}

/** Creation is a durable operation with the same policy for browser and app owners. */
export async function createSession(
  services: Services,
  context: TargetContext,
  input: SessionInput,
  requestId?: string,
) {
  const { owner, target } = context
  if (!services.active(owner)) throw new AppError('Sign in again to create a session.', 401)
  launchSize(input)
  const session = await services.sessions.create(
    context,
    input,
    sessionCreationKey(services, owner.userId, target.id, requestId),
  )
  services.log.record(owner, {
    kind: 'session',
    type: 'created',
    message: input.conversation
      ? `${session.name} was linked to an existing conversation`
      : `${session.name} was created`,
    machine: machine(context),
    session: named(session),
    details: { tool: session.tool, directory: session.rootDir },
  })
  return session
}

/** A new session on a new Git branch and worktree, with the source's tool and launch settings. */
export async function forkSession(services: Services, context: TargetContext, id: string, input: SessionForkInput) {
  const source = await services.sessions.get(context, id)
  const session = await services.sessions.fork(context, source.id, input)
  services.log.record(context.owner, {
    kind: 'session',
    type: 'forked',
    message: `${session.name} was forked onto branch ${input.branch}`,
    machine: machine(context),
    session: named(session),
    details: { source: source.id, branch: input.branch, directory: input.rootDir },
  })
  return session
}

export async function updateSession(services: Services, context: TargetContext, id: string, update: SessionUpdate) {
  const session = await services.sessions.update(context, id, update)
  const changed = describeChanges(update)
  if (changed.length)
    services.log.record(context.owner, {
      kind: 'session',
      type: 'edited',
      message: `${session.name} was edited: ${changed.join(', ')}`,
      machine: machine(context),
      session: named(session),
      details: { changed: changed.join(', ') },
    })
  return session
}

export async function switchSession(
  services: Services,
  context: TargetContext,
  id: string,
  conversation: string,
  reclaim = false,
) {
  const session = await services.sessions.switch(context, id, conversation, reclaim)
  services.log.record(context.owner, {
    kind: 'session',
    type: 'resumed',
    message: `${session.name} will continue an earlier conversation`,
    machine: machine(context),
    session: named(session),
    details: { conversation, ...(reclaim ? { reclaim: true } : {}) },
  })
  return session
}

export async function newSessionConversation(services: Services, context: TargetContext, id: string) {
  const session = await services.sessions.newConversation(context, id)
  services.log.record(context.owner, {
    kind: 'session',
    type: 'edited',
    message: `${session.name} started a new conversation`,
    machine: machine(context),
    session: named(session),
    details: { conversation: session.conversation },
  })
  return session
}

export async function terminateSession(services: Services, context: TargetContext, id: string) {
  const session = await services.sessions.terminate(context, id)
  services.broker.closeTarget(context.owner, context.target.id, id)
  return session
}

export async function deleteSession(services: Services, context: TargetContext, id: string, hub?: ChatHub) {
  const session = await services.sessions.get(context, id).catch(() => null)
  await services.sessions.remove(context, id)
  services.broker.closeTarget(context.owner, context.target.id, id)
  await hub?.sessionDeleted(context.owner, { targetId: context.target.id, sessionId: id })
  services.log.record(context.owner, {
    kind: 'session',
    type: 'deleted',
    message: `${session?.name ?? 'A session'} was deleted`,
    machine: machine(context),
    session: { id, name: session?.name ?? id.slice(0, 8) },
  })
}

export async function terminalLaunch(
  services: Services,
  context: TargetContext,
  sessionId: string,
  signal: AbortSignal,
) {
  const { owner, target } = context
  const session = await services.sessions.get(context, sessionId, signal)
  const title = `${session.name} · ${target.name}`
  if (!services.active(owner)) throw new AppError('Sign in again to connect.', 401)
  return { launch: services.tokens.issue({ owner, targetId: target.id, sessionId }), title }
}

export function desktopSession(session: Session, target: { id: string; name: string }): DesktopSession {
  return {
    sessionId: session.id,
    targetId: target.id,
    title: `${session.name} · ${target.name}`,
    detail: `${session.tool} · ${session.rootDir} · ${session.status}`.slice(0, 4096),
    tool: session.tool,
  }
}

export async function inspectTargetSoftware(services: Services, context: TargetContext, signal: AbortSignal) {
  const report = await services.software.inspect(context, signal)
  if (!services.active(context.owner)) throw new AppError('Sign in again to inspect this machine.', 401)
  if (coreSoftware.every(id => report.software.some(item => item.id === id && item.status === 'installed'))) {
    await context.workspace.setEnvironment(context.target.id, report.environment)
    // Refresh the cached machine connection's transport with the newly detected shell.
    await services.resolve(context.owner, context.target.id).catch(() => {})
  }
  return report
}
