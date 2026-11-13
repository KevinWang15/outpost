import { createHmac, timingSafeEqual } from 'node:crypto'

/** HMAC-signed JSON payloads, `data.signature`, with the purpose bound into the signature. */
export class Signer {
  private used = new Map<string, number>()
  constructor(
    private secret: string,
    private purpose: string,
    private maxLength: number,
  ) {}
  private sign(data: string) {
    return createHmac('sha256', this.secret).update(`${this.purpose}:${data}`).digest('base64url')
  }
  seal(payload: object) {
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return `${data}.${this.sign(data)}`
  }
  /** The payload of a correctly signed token; the caller validates its shape. */
  open(token: string): Record<string, unknown> | null {
    if (token.length > this.maxLength) return null
    const [data, signature, extra] = token.split('.')
    if (!data || !signature || extra !== undefined) return null
    const expected = Buffer.from(this.sign(data)),
      provided = Buffer.from(signature)
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null
    try {
      const payload: unknown = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))
      return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  /** Record a single-use id until it expires; false when it was already used. */
  once(id: string, expires: number) {
    const now = Date.now()
    for (const [used, until] of this.used) if (until <= now) this.used.delete(used)
    if (this.used.has(id)) return false
    this.used.set(id, expires)
    return true
  }
}

export const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128
