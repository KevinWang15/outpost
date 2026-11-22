import { createHmac, createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from 'node:crypto'

export const leaseMs = 45_000
export const endpointProof = (key: string, challenge: string) =>
  createHmac('sha256', Buffer.from(key, 'base64url')).update(challenge).digest('base64url')

export function directAuthority(secret: string, owner: string, target: string, enrollment = '') {
  // RFC 8410 PKCS#8 Ed25519 seed. Each account/target gets a separate signing key.
  const seed = createHmac('sha256', secret)
    .update(JSON.stringify(['outpost/direct', owner, target, enrollment]))
    .digest()
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  })
  return {
    proofKey: createHmac('sha256', seed).update('endpoint identity').digest('base64url'),
    publicKey: createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64url'),
    issue(operation: string, data: object) {
      const payload = Buffer.from(
        JSON.stringify({ target, operation, data, id: randomUUID(), until: Date.now() + leaseMs }),
      ).toString('base64url')
      return payload + '.' + sign(null, Buffer.from(payload), key).toString('base64url')
    },
  }
}
export class DirectTickets {
  private key: KeyObject
  private used = new Map<string, number>()
  constructor(
    publicKey: string,
    private target: string,
  ) {
    this.key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' })
    if (this.key.asymmetricKeyType !== 'ed25519') throw Error('Expected an Ed25519 public key.')
  }
  redeem<T>(ticket: unknown, operation: string): { data: T; until: number } {
    if (typeof ticket !== 'string' || ticket.length > 512 * 1024) throw Error('Invalid direct grant.')
    const [payload, signature, extra] = ticket.split('.')
    if (
      !payload ||
      !signature ||
      extra !== undefined ||
      !verify(null, Buffer.from(payload), this.key, Buffer.from(signature, 'base64url'))
    )
      throw Error('Invalid direct signature.')
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString())
    const now = Date.now()
    for (const [id, until] of this.used) if (until <= now) this.used.delete(id)
    if (
      p.target !== this.target ||
      p.operation !== operation ||
      typeof p.id !== 'string' ||
      !Number.isSafeInteger(p.until) ||
      p.until <= now ||
      p.until > now + leaseMs + 5000 ||
      this.used.has(p.id)
    )
      throw Error('Invalid or expired direct grant.')
    this.used.set(p.id, p.until)
    return { data: p.data, until: p.until }
  }
}
