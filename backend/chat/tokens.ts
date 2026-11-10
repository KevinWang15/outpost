import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Owner } from '../deployment'

interface Payload {
  v: 1
  k: 'ticket' | 'resume'
  i: string
  u: string
  l: string
  e: number
}
const ticketLifetime = 5 * 60_000
const resumeLifetime = 30 * 24 * 60 * 60_000
const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 128

/** Chat credentials are owner-scoped: tickets open one desktop chat socket
 * (single use, five minutes); resume grants authorize that page's image uploads
 * and reconnection. Both are bound to the issuing login. */
export class ChatTokens {
  private used = new Map<string, number>()
  constructor(private secret: string) {}
  private sign(data: string) {
    return createHmac('sha256', this.secret).update(`outpost-chat:${data}`).digest('base64url')
  }
  private encode(payload: Payload) {
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${data}.${this.sign(data)}`
  }
  ticket(owner: Owner) {
    const expires = Date.now() + ticketLifetime
    return this.encode({ v: 1, k: 'ticket', i: randomUUID(), u: owner.userId, l: owner.loginId, e: expires })
  }
  resume(owner: Owner) {
    return this.encode({
      v: 1,
      k: 'resume',
      i: randomUUID(),
      u: owner.userId,
      l: owner.loginId,
      e: Date.now() + resumeLifetime,
    })
  }
  private verify(token: string): { kind: Payload['k']; id: string; expires: number; owner: Owner } | null {
    if (token.length > 4096) return null
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
      payload?.v !== 1 ||
      !['ticket', 'resume'].includes(payload.k) ||
      ![payload.i, payload.u, payload.l].every(text) ||
      !Number.isSafeInteger(payload.e) ||
      payload.e <= Date.now()
    )
      return null
    return { kind: payload.k, id: payload.i, expires: payload.e, owner: { userId: payload.u, loginId: payload.l } }
  }
  /** A socket accepts a fresh ticket once, or a resume grant. */
  redeem(token: string): Owner | null {
    const verified = this.verify(token)
    if (!verified) return null
    if (verified.kind === 'ticket') {
      const now = Date.now()
      for (const [id, until] of this.used) if (until <= now) this.used.delete(id)
      if (this.used.has(verified.id)) return null
      this.used.set(verified.id, verified.expires)
    }
    return verified.owner
  }
  /** Uploads accept resume grants only. */
  authorize(token: string): Owner | null {
    const verified = this.verify(token)
    return verified?.kind === 'resume' ? verified.owner : null
  }
}
