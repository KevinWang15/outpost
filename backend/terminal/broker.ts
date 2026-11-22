import { randomUUID, randomBytes } from 'node:crypto'
import { endpointProof, type directAuthority } from '../../shared/node/directTickets'
import { WebSocket } from 'ws'
import { Connection, closedMessages } from '../../shared/node/terminalViewer'
import type { CloseReason, ServerMessage } from '../../shared/protocol'
import { protocolVersion } from '../../shared/protocol'
import { machineEndpoint, type Target } from '../../shared/model'
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
}

interface Dependencies {
  authority(owner: Owner, target: Target): ReturnType<typeof directAuthority> | undefined
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
    const dimension = (value: string | undefined, fallback: number, maximum: number) => {
      const requested = Number(value ?? fallback)
      return Number.isInteger(requested) ? Math.max(2, Math.min(maximum, requested)) : fallback
    }
    const cols = dimension(query.cols, 80, terminalService.maxCols)
    const rows = dimension(query.rows, 24, terminalService.maxRows)
    const start = query.start === '1'
    const connection = new Connection(grant, socket, this)
    this.connections.add(connection)
    try {
      const context = await this.dependencies.resolve(grant.owner, grant.targetId)
      if (connection.abort.signal.aborted) return
      const resume = this.dependencies.tokens.resume(redeemed.id, grant)
      const endpoint = machineEndpoint(context.target)
      const authority = endpoint && this.dependencies.authority(grant.owner, context.target)
      if (endpoint && authority) {
        const challenge = randomBytes(24).toString('base64url')
        const direct = await connection.chooseRoute({
          type: 'route-offer',
          origin: endpoint,
          challenge,
          proof: endpointProof(authority.proofKey, challenge),
          resume,
          relay: context.target.kind === 'paired' && context.machine.relayConnected,
        })
        if (connection.abort.signal.aborted) return
        if (direct) {
          const lease = randomUUID()
          connection.authorizeDirect()
          connection.send({
            type: 'direct-attach',
            ticket: authority.issue('attach', {
              lease,
              session: grant.sessionId,
              name: context.target.name,
              cols,
              rows,
              start,
            }),
          })
          const timer = setInterval(() => {
            if (!this.dependencies.active(grant.owner)) return connection.close('expired', 'Sign in again.')
            connection.send({ type: 'direct-lease', ticket: authority.issue('renew', { lease }) })
          }, 15000).unref()
          connection.abort.signal.addEventListener('abort', () => clearInterval(timer), { once: true })
          return
        }
        if (context.target.kind === 'direct')
          return connection.close(
            'error',
            'The direct-only machine is unreachable. Check its HTTPS address and your network connection.',
          )
      }
      const session = await this.dependencies.sessions.get(context, grant.sessionId, connection.abort.signal)
      if (socket.readyState !== WebSocket.OPEN) return
      connection.named = {
        machine: { id: context.target.id, name: context.target.name },
        session: { id: session.id, name: session.name },
      }
      connection.send({
        type: 'hello',
        resume,
        session: { id: session.id, name: session.name, tool: session.tool },
        target: { id: context.target.id, name: context.target.name },
      })
      const stream = await this.dependencies.sessions.attach(
        context,
        grant.sessionId,
        cols,
        rows,
        start,
        connection.abort.signal,
      )
      connection.send({
        type: 'route-selected',
        route: context.target.kind === 'paired' ? 'relay' : 'server-managed',
      })
      connection.start(stream)
    } catch (error) {
      const failure = terminalFailure(error)
      connection.close(failure.reason, failure.message)
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
