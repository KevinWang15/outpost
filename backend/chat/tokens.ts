import type { Owner } from '../deployment'
import { Signer, text } from '../signed'

const fileGrantLifetime = 30 * 24 * 60 * 60_000

export class ChatTokens {
  private signer: Signer
  constructor(secret: string) {
    this.signer = new Signer(secret, 'outpost-chat', 4096)
  }
  issueFileGrant(owner: Owner) {
    return this.signer.seal({
      v: 2,
      u: owner.userId,
      l: owner.loginId,
      e: Date.now() + fileGrantLifetime,
    })
  }
  authorize(token: string): Owner | null {
    const payload = this.signer.open(token)
    if (
      payload?.v !== 2 ||
      !text(payload.u) ||
      !text(payload.l) ||
      !Number.isSafeInteger(payload.e) ||
      (payload.e as number) <= Date.now()
    )
      return null
    return { userId: payload.u, loginId: payload.l }
  }
}
