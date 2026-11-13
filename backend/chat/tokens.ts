import { randomUUID } from 'node:crypto'
import type { Owner } from '../deployment'
import { Signer, text } from '../signed'

const ticketLifetime = 5 * 60_000
const resumeLifetime = 30 * 24 * 60 * 60_000

/** Chat credentials are owner-scoped: tickets open one desktop chat socket
 * (single use, five minutes); resume grants authorize that page's image uploads
 * and reconnection. Both are bound to the issuing login. */
export class ChatTokens {
  private signer: Signer
  constructor(secret: string) {
    this.signer = new Signer(secret, 'outpost-chat', 4096)
  }
  private issue(kind: 'ticket' | 'resume', owner: Owner, lifetime: number) {
    return this.signer.seal({
      v: 1,
      k: kind,
      i: randomUUID(),
      u: owner.userId,
      l: owner.loginId,
      e: Date.now() + lifetime,
    })
  }
  ticket(owner: Owner) {
    return this.issue('ticket', owner, ticketLifetime)
  }
  resume(owner: Owner) {
    return this.issue('resume', owner, resumeLifetime)
  }
  private verify(token: string) {
    const payload = this.signer.open(token)
    if (
      payload?.v !== 1 ||
      (payload.k !== 'ticket' && payload.k !== 'resume') ||
      !text(payload.i) ||
      !text(payload.u) ||
      !text(payload.l) ||
      !Number.isSafeInteger(payload.e) ||
      (payload.e as number) <= Date.now()
    )
      return null
    return {
      kind: payload.k,
      id: payload.i,
      expires: payload.e as number,
      owner: { userId: payload.u, loginId: payload.l },
    }
  }
  /** A socket accepts a fresh ticket once, or a resume grant. */
  redeem(token: string): Owner | null {
    const verified = this.verify(token)
    if (!verified) return null
    if (verified.kind === 'ticket' && !this.signer.once(verified.id, verified.expires)) return null
    return verified.owner
  }
  /** Uploads accept resume grants only. */
  authorize(token: string): Owner | null {
    const verified = this.verify(token)
    return verified?.kind === 'resume' ? verified.owner : null
  }
}
