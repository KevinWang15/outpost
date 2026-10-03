import { createHmac, timingSafeEqual } from 'node:crypto'
import { Ajv } from 'ajv'
import { AppError } from './errors'

type ConnectionShell = 'bash' | 'powershell'
interface Ticket { targetId: string; sessionId: string; shell: ConnectionShell; expires: number }
const id = { type: 'string', minLength: 1, maxLength: 80, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }
const validTicket = new Ajv({ coerceTypes: false, useDefaults: false, removeAdditional: false }).compile<Ticket>({
  type: 'object', additionalProperties: false, required: ['targetId', 'sessionId', 'shell', 'expires'],
  properties: { targetId: id, sessionId: id, shell: { enum: ['bash', 'powershell'] }, expires: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } },
})

// Tickets carry only identity, shell, and expiry. Each download reads current target settings.
export class ConnectionTickets {
  constructor(private secret: string) {}
  private sign(payload: string) { return createHmac('sha256', this.secret).update(payload).digest('base64url') }
  private encode(ticket: Ticket) {
    const payload = Buffer.from(JSON.stringify(ticket)).toString('base64url')
    return `${payload}.${this.sign(payload)}`
  }
  issue(targetId: string, sessionId: string) {
    const expires = Date.now() + 15 * 60_000
    return {
      expiresAt: new Date(expires).toISOString(),
      tokens: {
        bash: this.encode({ targetId, sessionId, expires, shell: 'bash' }),
        powershell: this.encode({ targetId, sessionId, expires, shell: 'powershell' }),
      },
    }
  }
  verify(token: string): Ticket {
    const parts = token.split('.')
    if (parts.length !== 2) throw new AppError('Invalid connection link', 403)
    const [payload, signature] = parts
    const expected = Buffer.from(this.sign(payload)), provided = Buffer.from(signature)
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw new AppError('Invalid connection link', 403)
    let ticket: unknown
    try { ticket = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) }
    catch { throw new AppError('Invalid connection link', 403) }
    if (!validTicket(ticket)) throw new AppError('Invalid connection link', 403)
    if (ticket.expires <= Date.now()) throw new AppError('Connection link expired. Generate a new command in the manager.', 410)
    return ticket
  }
}
