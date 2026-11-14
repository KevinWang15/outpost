// Session changes in the activity log, wherever they are made (the web app,
// chat, Outpost Desktop). Starts and stops come from the machine itself.
import type { Session, SessionUpdate } from '../../shared/model'
import type { SessionService, TargetContext } from '../sessions'
import type { ActivityLog } from './activity'

const machine = (context: TargetContext) => ({ id: context.target.id, name: context.target.name })
const named = (session: Session) => ({ id: session.id, name: session.name })

/** What an edit changed, in words. */
function changes(update: SessionUpdate) {
  return [
    update.name !== undefined && 'name',
    update.instructions !== undefined && 'instructions',
    update.model !== undefined && 'model',
    update.mode !== undefined && 'mode',
    update.mcpServers !== undefined && 'MCP servers',
    update.args !== undefined && 'arguments',
    update.env !== undefined && 'environment',
    update.delivery !== undefined && 'message delivery',
  ].filter(Boolean) as string[]
}

export function loggedSessions(sessions: SessionService, log: ActivityLog): SessionService {
  const wrapped: Partial<SessionService> = {
    async create(context, input, creationKey) {
      const session = await sessions.create(context, input, creationKey)
      log.record(context.owner, {
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
    },
    async fork(context, id, input) {
      const session = await sessions.fork(context, id, input)
      log.record(context.owner, {
        kind: 'session',
        type: 'forked',
        message: `${session.name} was forked onto branch ${input.branch}`,
        machine: machine(context),
        session: named(session),
        details: { source: id, branch: input.branch, directory: input.rootDir },
      })
      return session
    },
    async update(context, id, update) {
      const session = await sessions.update(context, id, update)
      const changed = changes(update)
      if (changed.length)
        log.record(context.owner, {
          kind: 'session',
          type: 'edited',
          message: `${session.name} was edited: ${changed.join(', ')}`,
          machine: machine(context),
          session: named(session),
          details: { changed: changed.join(', ') },
        })
      return session
    },
    async switch(context, id, conversation) {
      const session = await sessions.switch(context, id, conversation)
      log.record(context.owner, {
        kind: 'session',
        type: 'resumed',
        message: `${session.name} will continue an earlier conversation`,
        machine: machine(context),
        session: named(session),
        details: { conversation },
      })
      return session
    },
    async remove(context, id) {
      const session = await sessions.get(context, id).catch(() => null)
      await sessions.remove(context, id)
      log.record(context.owner, {
        kind: 'session',
        type: 'deleted',
        message: `${session?.name ?? 'A session'} was deleted`,
        machine: machine(context),
        session: { id, name: session?.name ?? id.slice(0, 8) },
      })
    },
  }
  return Object.assign(Object.create(sessions) as SessionService, wrapped)
}
