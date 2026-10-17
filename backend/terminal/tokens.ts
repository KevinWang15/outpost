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

/** Launch tokens start one connection (short-lived and single use). Resume tokens are returned over the WebSocket and used
 * for reconnection and image uploads, never in launcher links. Both are bound to
 * one owner, target and session. */
export class ConnectTokens {
  private used = new Map<string, number>()
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
  private verify(token: string) {
    if (token.length > 8192) return null
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
    return {
      id: payload.i,
      kind: payload.k,
      expires: payload.e,
      grant: {
        owner: { userId: payload.u, loginId: payload.l },
        targetId: payload.t,
        sessionId: payload.s,
      },
    }
  }
  /** Authorize ancillary requests without accepting or consuming launch tickets. */
  authorize(token: string): Grant | null {
    const verified = this.verify(token)
    return verified?.kind === 'resume' ? verified.grant : null
  }
  /** Verify a token; a launch token is consumed. */
  redeem(token: string, expectedGrant?: Grant) {
    const verified = this.verify(token)
    if (!verified) return null
    const { id, kind, grant, expires } = verified
    // A launch routed to an existing tab must belong to that exact session/login.
    if (
      expectedGrant &&
      (kind !== 'launch' ||
        grant.owner.userId !== expectedGrant.owner.userId ||
        grant.owner.loginId !== expectedGrant.owner.loginId ||
        grant.targetId !== expectedGrant.targetId ||
        grant.sessionId !== expectedGrant.sessionId)
    )
      return null
    this.prune()
    if (kind === 'launch') {
      if (this.used.has(id)) return null
      this.used.set(id, expires)
    }
    return { id, kind, grant }
  }
}
