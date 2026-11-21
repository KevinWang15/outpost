import { randomUUID } from 'node:crypto'
import { directAuthority } from '../../shared/node/directTickets'
import { WebSocket } from 'ws'
import { Connection, closedMessages } from '../../shared/node/terminalViewer'
import type { CloseReason, ServerMessage } from '../../shared/protocol'
import { protocolVersion } from '../../shared/protocol'
import { terminalService } from '../../shared/terminalService'
import type { Owner } from '../deployment'
import { terminalFailure } from './failures'
import type { SessionService, TargetContext } from '../sessions'
import type { LogInput } from '../logs/activity'
import type { ConnectTokens, Grant } from './tokens'

export interface TerminalQuery {
  token?: string
  cols?: string
  rows?: string
  protocol?: string
  start?: string
  routes?: string
}

interface Dependencies {
  directSecret?: string
  tokens: ConnectTokens
  active(owner: Owner): boolean
  sessions: SessionService
  resolve(owner: Owner, targetId: string): Promise<TargetContext>
  /** Records terminal connections in the account's activity log. */
  log?(owner: Owner, input: LogInput): void
}

export class TerminalBroker {
  private connections = new Set<Connection<Grant>>()
  private sweep: NodeJS.Timeout
  private stopped = false
  constructor(private dependencies: Dependencies) {
    this.sweep = setInterval(() => {
      for (const connection of this.connections) {
        if (!dependencies.active(connection.grant.owner))
          connection.close('expired', 'Sign-in ended. Sign in and connect again.')
      }
    }, 5000).unref()
  }
  forget(connection: Connection<Grant>) {
    this.connections.delete(connection)
  }

  logged(connection: Connection<Grant>, change: 'opened' | 'closed') {
    const { named, closing } = connection
    if (!named) return
    const problem = closing && (closing.reason === 'error' || closing.reason === 'unavailable') ? closing : null
    this.dependencies.log?.(connection.grant.owner, {
      level: problem ? 'warning' : 'info',
      kind: 'terminal',
      type: change === 'opened' ? 'connected' : 'disconnected',
      message:
        change === 'opened'
          ? `A terminal connected to ${named.session.name}`
          : `A terminal disconnected from ${named.session.name}${problem ? `: ${problem.message}` : ''}`,
      ...named,
      details: closing ? { reason: closing.reason } : {},
    })
  }

  /** A fresh Connect can focus an existing tab without attaching another PTY. */
  activate(grant: Grant, token: string) {
    if (this.stopped || !this.dependencies.active(grant.owner)) return false
    const redeemed = this.dependencies.tokens.redeem(token, grant)
    if (!redeemed) return false
    return true
  }

  async accept(socket: WebSocket, query: TerminalQuery) {
    const reject = (reason: CloseReason, message: string) => {
      socket.send(JSON.stringify({ type: 'closed', reason, message } satisfies ServerMessage))
      socket.close(1000, reason)
    }
    // Checked before the token is redeemed, so the same link works after updating.
    if (query.protocol !== String(protocolVersion)) {
      return reject('outdated', 'Outpost was updated. Reload this terminal to reconnect.')
    }
    const redeemed = this.stopped ? null : this.dependencies.tokens.redeem(query.token ?? '')
    if (!redeemed || !this.dependencies.active(redeemed.grant.owner)) return reject('expired', closedMessages.expired)
    const { grant } = redeemed
    if ([...this.connections].filter(connection => connection.grant.owner.userId === grant.owner.userId).length >= 16) {
      // After a network change, old viewers may occupy slots until their
      // heartbeat expires. An established session must be able to retry then.
      return reject(
        redeemed.kind === 'resume' ? 'error' : 'unavailable',
        'Too many open terminals. Close one and try again.',
      )
    }
    const cols = Number(query.cols ?? 80),
      rows = Number(query.rows ?? 24)
    const connection = new Connection(grant, socket, this)
    this.connections.add(connection)
    try {
      const context = await this.dependencies.resolve(grant.owner, grant.targetId)
      if (connection.abort.signal.aborted) return
      if (context.target.kind === 'direct') {
        if (query.routes !== '1' || !this.dependencies.directSecret)
          return connection.close('outdated', 'Update your terminal to use a direct-only machine.')
        const authority = directAuthority(this.dependencies.directSecret, grant.owner.userId, grant.targetId)
        const lease = randomUUID()
        const resume = this.dependencies.tokens.resume(redeemed.id, grant)
        connection.authorizeDirect()
        connection.send({
          type: 'direct-only',
          origin: context.target.endpoint,
          resume,
          ticket: authority.issue('attach', {
            lease,
            session: grant.sessionId,
            name: context.target.name,
            cols: Number.isInteger(cols) ? Math.max(2, Math.min(terminalService.maxCols, cols)) : 80,
            rows: Number.isInteger(rows) ? Math.max(2, Math.min(terminalService.maxRows, rows)) : 24,
            start: query.start === '1',
          }),
        })
        const timer = setInterval(() => {
          if (!this.dependencies.active(grant.owner)) return connection.close('expired', 'Sign in again.')
          connection.send({ type: 'direct-lease', ticket: authority.issue('renew', { lease }) })
        }, 15000).unref()
        connection.abort.signal.addEventListener('abort', () => clearInterval(timer), { once: true })
        return
      }
      const session = await this.dependencies.sessions.get(context, grant.sessionId, connection.abort.signal)
      if (socket.readyState !== WebSocket.OPEN) return
      connection.named = {
        machine: { id: context.target.id, name: context.target.name },
        session: { id: session.id, name: session.name },
      }
      connection.send({
        type: 'hello',
        resume: this.dependencies.tokens.resume(redeemed.id, grant),
        session: { id: session.id, name: session.name, tool: session.tool },
        target: { id: context.target.id, name: context.target.name },
      })
      let direct: string | undefined
      const origin = context.machine?.directOrigin
      if (query.routes === '1' && context.target.kind === 'paired' && origin) {
        const offer = await context.machine
          .call<{ slot: string; proof: string }>(
            'viewer.offer',
            { session: grant.sessionId },
            { signal: connection.abort.signal, timeoutMs: 3000 },
          )
          .catch(() => null)
        if (connection.abort.signal.aborted) return
        if (
          offer &&
          [offer.slot, offer.proof].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/.test(value)) &&
          (await connection.chooseRoute({ type: 'route-offer', origin, slot: offer.slot, proof: offer.proof }))
        )
          direct = offer.slot
      }
      if (connection.abort.signal.aborted) return
      const stream = await this.dependencies.sessions.attach(
        context,
        grant.sessionId,
        Number.isInteger(cols) ? Math.min(terminalService.maxCols, Math.max(2, cols)) : 80,
        Number.isInteger(rows) ? Math.min(terminalService.maxRows, Math.max(2, rows)) : 24,
        query.start === '1',
        connection.abort.signal,
        direct,
      )
      if (query.routes === '1' && (stream.opened as { route?: string } | null)?.route !== 'direct')
        connection.send({ type: 'route-selected', route: 'relay' })
      connection.start(stream)
    } catch (error) {
      const failure = terminalFailure(error)
      connection.close(failure.reason, failure.message)
    }
  }

  /** Availability hints reach every authorized viewer of this managed session. */
  filesChanged(grant: Grant) {
    for (const connection of this.connections) {
      const other = connection.grant
      if (
        other.owner.userId === grant.owner.userId &&
        other.targetId === grant.targetId &&
        other.sessionId === grant.sessionId
      )
        connection.send({ type: 'signal', signal: { type: 'files.changed', payload: {} } })
    }
  }

  /** Close connections after a session is terminated or deleted, or a target removed. */
  closeTarget(owner: Owner, targetId: string, sessionId?: string) {
    for (const connection of this.connections) {
      const { grant } = connection
      if (
        grant.owner.userId === owner.userId &&
        grant.targetId === targetId &&
        (!sessionId || grant.sessionId === sessionId)
      ) {
        connection.close('ended', 'This session was stopped from Outpost.')
      }
    }
  }

  close() {
    this.stopped = true
    clearInterval(this.sweep)
    for (const connection of this.connections) connection.close('error', 'Outpost is restarting. Reconnecting…')
  }
}
