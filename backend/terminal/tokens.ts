import { randomUUID } from 'node:crypto'
import type { Owner } from '../deployment'
import { Signer, text } from '../signed'

export interface Grant {
  owner: Owner
  targetId: string
  sessionId: string
}
const launchLifetime = 5 * 60_000
const resumeLifetime = 30 * 24 * 60 * 60_000

/** Launch tokens start one connection (short-lived and single use). Resume tokens are returned over the WebSocket and used
 * for reconnection and image uploads, never in launcher links. Both are bound to
 * one owner, target and session. */
export class ConnectTokens {
  private signer: Signer
  constructor(secret: string) {
    this.signer = new Signer(secret, 'outpost-terminal', 8192)
  }
  issue(grant: Grant) {
    const id = randomUUID(),
      expires = Date.now() + launchLifetime
    return {
      id,
      expiresAt: new Date(expires).toISOString(),
      token: this.signer.seal({
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
    return this.signer.seal({
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
    const payload = this.signer.open(token)
    if (
      payload?.v !== 2 ||
      (payload.k !== 'launch' && payload.k !== 'resume') ||
      !text(payload.i) ||
      !text(payload.u) ||
      !text(payload.l) ||
      !text(payload.t) ||
      !text(payload.s) ||
      !Number.isSafeInteger(payload.e) ||
      (payload.e as number) <= Date.now()
    )
      return null
    return {
      id: payload.i,
      kind: payload.k,
      expires: payload.e as number,
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
    if (kind === 'launch' && !this.signer.once(id, expires)) return null
    return { id, kind, grant }
  }
}
