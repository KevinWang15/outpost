import { createHash, randomBytes } from 'node:crypto'
import { AppError } from './errors'
import { signalTypePattern, type SessionSignal, type SignalMessage } from '../shared/signals'

export interface SignalOwner { userId: string; authSessionId: string }
interface Grant { owner: SignalOwner; targetId: string; sessionId: string; used: number; until: number }
interface Listener {
  id: string; owner: SignalOwner; types: Set<string>; deliver: (event: SessionSignal) => void | Promise<void>
  close: () => void; focused: boolean; visible: boolean; activeAt: number
}
const sameOwner = (a: SignalOwner, b: SignalOwner) => a.userId === b.userId && a.authSessionId === b.authSessionId
const digest = (token: string) => createHash('sha256').update(token).digest('hex')
const maxBody = 32 * 1024

/** Single-recipient dispatch. Once handed to a listener, an event is never
 * reassigned or replayed: losing an acknowledgement cannot open another tab. */
export class Signals {
  private grants = new Map<string, Grant>()
  private sessions = new Map<string, string>()
  private listeners = new Map<string, Listener>()
  private handlers = new Map<string, (event: SessionSignal) => void | Promise<void>>()
  private validators = new Map<string, (payload: unknown) => unknown>()
  private delivered = new Map<string, { fingerprint: string; until: number; result: Promise<{ id: string }> }>()
  private cleanup: NodeJS.Timeout
  private stopped = false
  constructor(private validOwner: (owner: SignalOwner) => boolean) {
    this.cleanup = setInterval(() => this.prune(), 1000).unref()
  }
  private prune() {
    for (const [key, entry] of this.delivered) if (entry.until <= Date.now()) this.delivered.delete(key)
    for (const [key, grant] of this.grants) if (!this.validOwner(grant.owner)) this.grants.delete(key)
    for (const [key, token] of this.sessions) if (!this.grants.has(digest(token))) this.sessions.delete(key)
    for (const listener of this.listeners.values()) if (!this.validOwner(listener.owner)) { this.listeners.delete(listener.id); listener.close() }
  }
  issue(owner: SignalOwner, targetId: string, sessionId: string) {
    this.prune()
    if (this.stopped) throw new AppError('Outpost is closing.', 503)
    if (!this.validOwner(owner)) throw new AppError('Sign in to continue.', 401)
    const key = JSON.stringify([owner.userId, owner.authSessionId, targetId, sessionId])
    const previous = this.sessions.get(key)
    if (previous) return previous
    if (this.grants.size >= 10000) throw new AppError('Too many active signal sessions.', 429)
    const token = randomBytes(32).toString('base64url')
    this.grants.set(digest(token), { owner: { ...owner }, targetId, sessionId, used: 0, until: 0 })
    this.sessions.set(key, token)
    return token
  }
  active(token: string) { const grant = this.grants.get(digest(token)); return Boolean(grant && this.validOwner(grant.owner)) }
  revoke(userId: string, targetId: string, sessionId?: string) {
    for (const [key, grant] of this.grants) if (grant.owner.userId === userId && grant.targetId === targetId && (!sessionId || grant.sessionId === sessionId)) this.grants.delete(key)
    this.prune()
  }
  registerLocal(type: string, handler: (event: SessionSignal) => void | Promise<void>) {
    if (this.handlers.has(type)) throw new Error(`A local listener already handles ${type}`)
    this.handlers.set(type, handler)
    return () => { if (this.handlers.get(type) === handler) this.handlers.delete(type) }
  }
  define(type: string, validate: (payload: unknown) => unknown) { this.validators.set(type, validate) }
  listen(id: string, owner: SignalOwner, types: string[], deliver: Listener['deliver'], close: () => void) {
    this.prune()
    if (this.stopped) throw new AppError('Outpost is closing.', 503)
    if (!this.validOwner(owner)) throw new AppError('Sign in to continue.', 401)
    const existing = this.listeners.get(id)
    if (existing && !sameOwner(owner, existing.owner)) throw new AppError('Listener not found.', 404)
    if ([...this.listeners.values()].filter(entry => sameOwner(entry.owner, owner)).length >= 16 && !existing) throw new AppError('Too many signal listeners.', 429)
    if (existing) { this.listeners.delete(id); existing.close() }
    const listener: Listener = { id, owner: { ...owner }, types: new Set(types), deliver, close, focused: false, visible: false, activeAt: Date.now() }
    this.listeners.set(id, listener)
    return () => { if (this.listeners.get(id) === listener) this.listeners.delete(id) }
  }
  activity(id: string, owner: SignalOwner, focused: boolean, visible: boolean) {
    const listener = this.listeners.get(id)
    if (!listener || !sameOwner(listener.owner, owner)) throw new AppError('Listener not found.', 404)
    listener.focused = focused; listener.visible = visible
    if (focused) listener.activeAt = Date.now()
  }
  async dispatch(token: string, input: unknown): Promise<{ id: string }> {
    const grant = typeof token === 'string' && token.length === 43 ? this.grants.get(digest(token)) : undefined
    if (!grant || !this.validOwner(grant.owner)) throw new AppError('Invalid or expired Outpost session token. Reconnect the session.', 401)
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('Invalid signal envelope.', 400)
    let serialized: string
    try { serialized = JSON.stringify(input) } catch { throw new AppError('Invalid signal envelope.', 400) }
    if (Buffer.byteLength(serialized) > maxBody) throw new AppError('Invalid signal envelope.', 400)
    const message = input as SignalMessage
    if (message.version !== 1 || typeof message.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(message.id) || typeof message.type !== 'string' || message.type.length > 80 || !signalTypePattern.test(message.type) || !Object.hasOwn(message, 'payload') || Object.keys(message).some(key => !['version', 'id', 'type', 'payload'].includes(key))) throw new AppError('Invalid signal envelope.', 400)
    try { this.validators.get(message.type)?.(message.payload) } catch (error) { throw new AppError((error as Error).message, 400) }
    this.prune()
    const key = `${digest(token)}:${message.id}`, fingerprint = digest(serialized)
    const previous = this.delivered.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new AppError('Signal ID was already used for different content.', 409)
      return previous.result
    }
    const local = grant.owner.userId === 'local' ? this.handlers.get(message.type) : undefined
    const listener = [...this.listeners.values()]
      .filter(entry => sameOwner(entry.owner, grant.owner) && entry.types.has(message.type))
      .sort((a, b) => Number(b.focused) - Number(a.focused) || Number(b.visible) - Number(a.visible) || b.activeAt - a.activeAt)[0]
    if (!local && !listener) throw new AppError('No listener is registered for this signal. Open Outpost and try again.', 503)
    if (this.delivered.size >= 10000) throw new AppError('Too many signals. Try again later.', 429)
    if (grant.until <= Date.now()) { grant.until = Date.now() + 60_000; grant.used = 0 }
    if (++grant.used > 120) throw new AppError('Too many signals from this session. Try again in a minute.', 429)
    const event: SessionSignal = { ...message, targetId: grant.targetId, sessionId: grant.sessionId }
    // Reserve the ID before invoking even a synchronous listener.
    const result = Promise.resolve().then(async () => { await (local ?? listener!.deliver)(event); return { id: event.id } })
    this.delivered.set(key, { fingerprint, until: Date.now() + 60 * 60_000, result })
    return result
  }
  close() {
    this.stopped = true
    clearInterval(this.cleanup)
    for (const listener of this.listeners.values()) listener.close()
    this.listeners.clear(); this.grants.clear(); this.sessions.clear(); this.delivered.clear(); this.handlers.clear()
  }
}
