import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Owner } from '../deployment'

export interface Grant {
  owner: Owner
  targetId: string
  sessionId: string
}
interface Payload {
  v: 2
  k: 'launch' | 'resume'
  i: string
  u: string
  l: string
  t: string
  s: string
  e: number
}
const launchLifetime = 5 * 60_000
const resumeLifetime = 30 * 24 * 60 * 60_000
const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 128

/** Launch tokens start one connection (short-lived, single use, safe to put in
 * an outpost:// URL). Resume tokens are returned over the WebSocket and used
 * only to reconnect that socket, never in launcher links. Both are bound to
 * one owner, target and session. */
export class ConnectTokens {
  private used = new Map<string, number>()
  private connected = new Map<string, { userId: string; until: number }>()
  constructor(private secret: string) {}
  private sign(data: string) {
    return createHmac('sha256', this.secret).update(`outpost-terminal:${data}`).digest('base64url')
  }
  private encode(payload: Payload) {
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${data}.${this.sign(data)}`
  }
  private prune() {
    const now = Date.now()
    for (const [id, until] of this.used) if (until <= now) this.used.delete(id)
    for (const [id, entry] of this.connected) if (entry.until <= now) this.connected.delete(id)
  }
  /** Opaque routing identity, scoped to this login. It is never authorization. */
  desktopSessionKey(grant: Grant) {
    return createHmac('sha256', this.secret)
      .update('outpost-desktop-session:')
      .update(JSON.stringify([grant.owner.userId, grant.owner.loginId, grant.targetId, grant.sessionId]))
      .digest('base64url')
  }
  issue(grant: Grant) {
    const id = randomUUID(),
      expires = Date.now() + launchLifetime
    return {
      id,
      expiresAt: new Date(expires).toISOString(),
      token: this.encode({
        v: 2,
        k: 'launch',
        i: id,
        u: grant.owner.userId,
        l: grant.owner.loginId,
        t: grant.targetId,
        s: grant.sessionId,
        e: expires,
      }),
    }
  }
  resume(id: string, grant: Grant) {
    return this.encode({
      v: 2,
      k: 'resume',
      i: id,
      u: grant.owner.userId,
      l: grant.owner.loginId,
      t: grant.targetId,
      s: grant.sessionId,
      e: Date.now() + resumeLifetime,
    })
  }
  /** Verify a token; a launch token is consumed. Returns null when invalid, expired or reused. */
  redeem(token: string, expectedGrant?: Grant): { id: string; kind: Payload['k']; grant: Grant } | null {
    const [data, signature, extra] = token.split('.')
    if (!data || !signature || extra !== undefined) return null
    const expected = Buffer.from(this.sign(data)),
      provided = Buffer.from(signature)
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null
    let payload: Payload
    try {
      payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))
    } catch {
      return null
    }
    if (
      payload?.v !== 2 ||
      !['launch', 'resume'].includes(payload.k) ||
      ![payload.i, payload.u, payload.l, payload.t, payload.s].every(text) ||
      !Number.isSafeInteger(payload.e) ||
      payload.e <= Date.now()
    )
      return null
    // Reusing an attached tab must not consume a ticket for another session or
    // login. The desktop launch envelope is only a routing hint.
    if (
      expectedGrant &&
      (payload.k !== 'launch' ||
        payload.u !== expectedGrant.owner.userId ||
        payload.l !== expectedGrant.owner.loginId ||
        payload.t !== expectedGrant.targetId ||
        payload.s !== expectedGrant.sessionId)
    )
      return null
    this.prune()
    if (payload.k === 'launch') {
      if (this.used.has(payload.i)) return null
      this.used.set(payload.i, payload.e)
    }
    return {
      id: payload.i,
      kind: payload.k,
      grant: {
        owner: { userId: payload.u, loginId: payload.l },
        targetId: payload.t,
        sessionId: payload.s,
      },
    }
  }
  markConnected(id: string, owner: Owner) {
    this.connected.set(id, { userId: owner.userId, until: Date.now() + launchLifetime })
  }
  /** Whether the client for a launch token has attached, for "Connected in Outpost Desktop". */
  status(owner: Owner, id: string): 'pending' | 'connected' {
    this.prune()
    return this.connected.get(id)?.userId === owner.userId ? 'connected' : 'pending'
  }
}
