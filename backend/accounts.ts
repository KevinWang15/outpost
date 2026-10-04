import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AccountUser } from '../shared/auth'
import { isLoopbackAddress } from '../shared/loopback'
import { AppError } from './errors'
import { AccountStore, type AccountSession } from './account-store'
import { AccountSshKeys, AccountTargetStore } from './account-ssh'
import { accountEmail, engageLabMailer, type AccountMailer } from './account-email'
import { hashPassword, validatePassword, verifyPassword } from './account-passwords'

declare module 'fastify' { interface FastifyRequest { account: AccountSession | null } }
const COOKIE = 'outpost_session'
const normalizeEmail = (value: string) => value.trim().toLowerCase()
const normalizedName = (value: string) => {
  const name = value.trim()
  if (!name) throw new AppError('Name is required.', 400)
  return name
}
const emailField = { type: 'string', minLength: 3, maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' }
const passwordField = { type: 'string', minLength: 8, maxLength: 1024 }
const tokenField = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' }
const body = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties })

class AccountRateLimit {
  private buckets = new Map<string, { count: number; until: number }>()
  consume(key: string, limit: number) {
    const now = Date.now()
    if (this.buckets.size >= 10000) {
      for (const [name, entry] of this.buckets) if (entry.until <= now) this.buckets.delete(name)
      if (this.buckets.size >= 10000 && !this.buckets.has(key)) throw new AppError('Too many requests. Please try again later.', 429)
    }
    const previous = this.buckets.get(key)
    const bucket = previous && previous.until > now ? previous : { count: 0, until: now + 15 * 60_000 }
    if (bucket.count >= limit) throw new AppError('Too many attempts. Please try again in 15 minutes.', 429)
    bucket.count++
    this.buckets.set(key, bucket)
  }
  check(request: FastifyRequest, action: string, email?: string) {
    this.consume(`${action}:ip:${request.ip}`, action === 'login' ? 50 : 20)
    if (email) this.consume(`${action}:email:${email}`, action === 'login' ? 10 : 5)
  }
}

interface AccountOptions {
  directory?: string
  publicUrl: string
  production?: boolean
  mailer?: AccountMailer | null
}
export class Accounts {
  readonly keys: AccountSshKeys
  private workspaces = new Map<string, AccountTargetStore>()
  private rateLimit = new AccountRateLimit()
  private constructor(readonly publicUrl: URL, readonly production: boolean, readonly store: AccountStore, private mailer: AccountMailer | null, private dummyPassword: string) {
    this.keys = new AccountSshKeys(store.directory)
  }
  static async open(options: AccountOptions) {
    const origin = new URL(options.publicUrl)
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      throw new Error('PUBLIC_APP_URL must be an HTTP(S) origin without credentials, a path, or a query.')
    }
    const production = options.production ?? (process.env.NODE_ENV === 'production' || !(origin.hostname === 'localhost' || isLoopbackAddress(origin.hostname.replace(/^\[|\]$/g, ''))))
    if (production && origin.protocol !== 'https:') throw new Error('Hosted production mode requires an HTTPS PUBLIC_APP_URL.')
    const mailer = options.mailer === undefined ? engageLabMailer() : options.mailer
    if (production && !mailer) throw new Error('Hosted production mode requires ENGAGE_LAB_USERNAME, ENGAGE_LAB_API_KEY, and ENGAGE_LAB_FROM_EMAIL.')
    const dummyPassword = await hashPassword(randomBytes(32).toString('hex'))
    const store = await AccountStore.open(options.directory ?? process.env.OUTPOST_DATA_DIR ?? join(homedir(), '.outpost'))
    return new Accounts(origin, production, store, mailer, dummyPassword)
  }
  close() { this.store.close() }
  allowsHost(host: string) {
    try {
      const url = new URL(`${this.publicUrl.protocol}//${host}`)
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false
      return url.host === this.publicUrl.host || (!this.production && (url.hostname === 'localhost' || isLoopbackAddress(url.hostname.replace(/^\[|\]$/g, ''))))
    } catch { return false }
  }
  allowsOrigin(origin: string) {
    try {
      const url = new URL(origin)
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false
      return url.origin === this.publicUrl.origin || (!this.production && ['http:', 'https:'].includes(url.protocol) && (url.hostname === 'localhost' || isLoopbackAddress(url.hostname.replace(/^\[|\]$/g, ''))))
    } catch { return false }
  }
  authenticate(request: FastifyRequest) {
    const session = this.store.session(request.cookies[COOKIE] ?? '')
    if (!session) throw new AppError('Sign in to continue.', 401)
    request.account = session
    return session
  }
  targetStore(userId: string) {
    let store = this.workspaces.get(userId)
    if (!store) {
      store = new AccountTargetStore(this.store.directory, userId, this.keys)
      this.workspaces.set(userId, store)
    }
    return store
  }
  private cookie(reply: FastifyReply, user: AccountUser) {
    const session = this.store.issueSession(user)
    reply.setCookie(COOKIE, session.token, { httpOnly: true, secure: this.publicUrl.protocol === 'https:', sameSite: 'lax', path: '/', maxAge: 30 * 24 * 60 * 60 })
  }
  private clearCookie(reply: FastifyReply) { reply.clearCookie(COOKIE, { path: '/', httpOnly: true, secure: this.publicUrl.protocol === 'https:', sameSite: 'lax' }) }
  private async deliver(user: AccountUser, purpose: 'verify' | 'reset'): Promise<{ delivered: boolean; devUrl?: string }> {
    const token = this.store.issueToken(user.id, purpose, purpose === 'verify' ? 24 * 60 * 60_000 : 60 * 60_000)
    const url = new URL(purpose === 'verify' ? '/verify-email' : '/reset-password', this.publicUrl)
    url.searchParams.set('token', token)
    if (!this.mailer) return { delivered: true, devUrl: url.href }
    try { await this.mailer(accountEmail(user.name, user.email, url.href, purpose)); return { delivered: true } }
    catch { return { delivered: false } }
  }
  register(app: FastifyInstance) {
    const limited = (action: string) => async (request: FastifyRequest) => {
      const input = request.body as { email?: string } | undefined
      this.rateLimit.check(request, action, typeof input?.email === 'string' ? normalizeEmail(input.email) : undefined)
    }
    app.get('/api/auth/session', async request => ({ mode: 'hosted', user: this.store.session(request.cookies[COOKIE] ?? '')?.user ?? null }))
    app.post<{ Body: { email: string; name: string; password: string } }>('/api/auth/signup', {
      schema: { body: body({ email: emailField, name: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }, password: passwordField }) }, preHandler: limited('signup'),
    }, async (request, reply) => {
      const email = normalizeEmail(request.body.email), name = normalizedName(request.body.name)
      const user = this.store.create(email, name, await hashPassword(request.body.password))
      const delivery = await this.deliver(user, 'verify')
      return reply.code(201).send({ email, message: delivery.delivered ? 'Account created. Check your email to verify it before signing in.' : 'Account created, but the verification email could not be delivered. Try resending it later.', ...(delivery.devUrl ? { devUrl: delivery.devUrl } : {}) })
    })
    app.post<{ Body: { email: string; password: string } }>('/api/auth/login', {
      schema: { body: body({ email: emailField, password: { type: 'string', minLength: 1, maxLength: 1024 } }) }, preHandler: limited('login'),
    }, async (request, reply) => {
      const user = this.store.byEmail(normalizeEmail(request.body.email))
      const valid = await verifyPassword(request.body.password, user?.passwordHash ?? this.dummyPassword)
      if (!user || !valid || this.store.byId(user.id)?.passwordHash !== user.passwordHash) throw new AppError('Invalid email or password.', 401)
      if (!user.emailVerifiedAt) return reply.code(403).send({ message: 'Verify your email before signing in.', code: 'EMAIL_NOT_VERIFIED' })
      this.store.revokeSession(request.cookies[COOKIE] ?? '')
      const safe = this.store.profile(user.id)!
      this.cookie(reply, safe)
      return { user: safe }
    })
    app.post('/api/auth/logout', async (request, reply) => {
      this.store.revokeSession(request.cookies[COOKIE] ?? '')
      this.clearCookie(reply)
      return reply.code(204).send()
    })
    app.post<{ Body: { email: string } }>('/api/auth/resend-verification', { schema: { body: body({ email: emailField }) }, preHandler: limited('resend') }, async request => {
      const user = this.store.byEmail(normalizeEmail(request.body.email))
      const delivery = user && !user.emailVerifiedAt ? await this.deliver(user, 'verify') : undefined
      return { message: 'If an unverified account exists, a new verification link has been sent.', ...(delivery?.devUrl ? { devUrl: delivery.devUrl } : {}) }
    })
    app.post<{ Body: { token: string } }>('/api/auth/verify-email', { schema: { body: body({ token: tokenField }) }, preHandler: limited('verify') }, async (request, reply) => {
      const user = this.store.consumeToken(request.body.token, 'verify')
      this.store.revokeSession(request.cookies[COOKIE] ?? '')
      this.cookie(reply, user)
      return { user, message: 'Email verified. Your workspace is ready.' }
    })
    app.post<{ Body: { email: string } }>('/api/auth/forgot-password', { schema: { body: body({ email: emailField }) }, preHandler: limited('forgot') }, async request => {
      const user = this.store.byEmail(normalizeEmail(request.body.email))
      const delivery = user ? await this.deliver(user, 'reset') : undefined
      return { message: 'If an account exists, a password reset link has been sent.', ...(delivery?.devUrl ? { devUrl: delivery.devUrl } : {}) }
    })
    app.post<{ Body: { token: string; password: string } }>('/api/auth/reset-password', { schema: { body: body({ token: tokenField, password: passwordField }) }, preHandler: limited('reset') }, async (request, reply) => {
      this.store.consumeToken(request.body.token, 'reset', await hashPassword(request.body.password))
      this.clearCookie(reply)
      return { message: 'Password reset. Sign in with your new password.' }
    })
    app.get('/api/account/ssh-key', async request => this.keys.publicKey(request.account!.user.id))
    app.patch<{ Body: { name: string } }>('/api/account/profile', { schema: { body: body({ name: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[^\\u0000-\\u001f\\u007f]+$' } }) } }, async request => ({ user: this.store.updateName(request.account!.user.id, normalizedName(request.body.name)) }))
    app.post<{ Body: { currentPassword: string; password: string } }>('/api/account/password', {
      schema: { body: body({ currentPassword: { type: 'string', minLength: 1, maxLength: 1024 }, password: passwordField }) }, preHandler: limited('password'),
    }, async (request, reply) => {
      const user = this.store.byId(request.account!.user.id)!
      if (!await verifyPassword(request.body.currentPassword, user.passwordHash)) throw new AppError('Current password is incorrect.', 400)
      validatePassword(request.body.password)
      const newHash = await hashPassword(request.body.password)
      this.authenticate(request)
      this.store.changePassword(user.id, newHash, user.passwordHash)
      this.clearCookie(reply)
      return { message: 'Password changed. Sign in again with your new password.' }
    })
  }
}
