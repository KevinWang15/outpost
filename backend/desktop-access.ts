import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FastifyRequest } from 'fastify'
import {
  desktopAuthorizationLifetime,
  desktopLoginLifetime,
  desktopLoginCallback,
  type DesktopCredential,
  type DesktopLogin,
  type DesktopAuthorization,
} from '../shared/desktopAuth'
import type { Deployment, Owner } from './deployment'
import { AppError } from './errors'

const secret = () => randomBytes(32).toString('base64url')
const hash = (value: string) => createHash('sha256').update(value).digest('base64url')
const ownerPrefix = 'desktop:'
interface Authorization {
  accountId?: string
  challenge: string
  state: string
  expiresAt: number
  approved?: { codeHash: string; userId: string; revision: string }
}

/** Browser approval issues an independent, revocable app login. Only hashes of
 * durable credentials reach disk. PKCE binds callbacks to their initiating app. */
export class DesktopAccess {
  private requests = new Map<string, Authorization>()
  private constructor(
    private deployment: Deployment,
    private db: DatabaseSync,
  ) {}

  static async open(deployment: Deployment) {
    await mkdir(deployment.directory, { recursive: true, mode: 0o700 })
    const path = join(deployment.directory, 'desktop-logins.sqlite')
    const db = new DatabaseSync(path)
    try {
      await chmod(path, 0o600)
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS logins (
          id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
          user_id TEXT NOT NULL, revision TEXT NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS logins_user ON logins(user_id);
      `)
      db.prepare('DELETE FROM logins WHERE expires_at <= ?').run(Date.now())
      return new DesktopAccess(deployment, db)
    } catch (error) {
      db.close()
      throw error
    }
  }
  close() {
    this.requests.clear()
    this.db.close()
  }
  start(challenge: string, state: string, accountId?: string): DesktopAuthorization {
    const now = Date.now()
    for (const [id, request] of this.requests) if (request.expiresAt <= now) this.requests.delete(id)
    if (this.requests.size >= 1000) throw new AppError('Too many pending sign-ins. Try again later.', 429)
    const requestId = secret(),
      expiresAt = now + desktopAuthorizationLifetime
    this.requests.set(requestId, { challenge, state, expiresAt, accountId })
    return { requestId, expiresAt }
  }
  private request(id: string) {
    const request = this.requests.get(id)
    if (!request || request.expiresAt <= Date.now()) {
      this.requests.delete(id)
      throw new AppError('This sign-in request expired. Start again in Outpost Desktop.', 410)
    }
    if (request.approved) throw new AppError('This sign-in request has already been approved.', 409)
    return request
  }
  describe(id: string) {
    const request = this.request(id)
    return { expiresAt: request.expiresAt, accountId: request.accountId ?? null }
  }
  approve(id: string, owner: Owner, allow: boolean) {
    const request = this.request(id)
    const identity = this.deployment.account(owner.userId)
    if (!this.deployment.active(owner) || !identity) throw new AppError('Sign in to continue.', 401)
    if (!allow) {
      this.requests.delete(id)
      return { callback: desktopLoginCallback(request.state, 'denied') }
    }
    if (request.accountId && request.accountId !== owner.userId)
      throw new AppError('Sign in with the same account as the website that opened the app.', 403)
    const code = secret()
    request.approved = { codeHash: hash(code), userId: owner.userId, revision: identity.revision }
    request.expiresAt = Math.min(request.expiresAt, Date.now() + 60_000)
    return { callback: desktopLoginCallback(request.state, code) }
  }
  exchange(code: string, verifier: string): DesktopCredential {
    const codeHash = hash(code)
    const entry = [...this.requests].find(([, request]) => request.approved?.codeHash === codeHash)
    if (!entry || entry[1].expiresAt <= Date.now() || entry[1].challenge !== hash(verifier))
      throw new AppError('This authorization code is invalid or expired. Start sign-in again.', 401)
    const [id, request] = entry
    this.requests.delete(id)
    const approval = request.approved!
    const identity = this.deployment.account(approval.userId)
    if (!identity || identity.revision !== approval.revision) throw new AppError('Sign in again to continue.', 401)
    const token = `op_app_${secret()}`,
      loginId = ownerPrefix + randomUUID(),
      expiresAt = Date.now() + desktopLoginLifetime
    this.db.prepare('DELETE FROM logins WHERE expires_at <= ?').run(Date.now())
    this.db.prepare('DELETE FROM logins WHERE user_id = ? AND revision <> ?').run(approval.userId, identity.revision)
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM logins WHERE user_id = ?').get(approval.userId)!
    if (Number(count.count) >= 64) throw new AppError('Too many app logins. Sign out of another device first.', 429)
    this.db
      .prepare('INSERT INTO logins (id, token_hash, user_id, revision, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(loginId, hash(token), approval.userId, identity.revision, expiresAt)
    return { token, account: identity.account, expiresAt }
  }
  /** One owner liveness check is used by HTTP uploads and live terminal sockets. */
  active(owner: Owner): boolean {
    if (!owner.loginId.startsWith(ownerPrefix)) return this.deployment.active(owner)
    const row = this.db
      .prepare('SELECT revision FROM logins WHERE id = ? AND user_id = ? AND expires_at > ?')
      .get(owner.loginId, owner.userId, Date.now())
    return !!row && this.deployment.account(owner.userId)?.revision === row.revision
  }
  authorize(request: FastifyRequest): Owner {
    const match = /^Bearer (op_app_[A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')
    const row = match
      ? this.db.prepare('SELECT id, user_id FROM logins WHERE token_hash = ?').get(hash(match[1]))
      : undefined
    const owner = row ? { userId: String(row.user_id), loginId: String(row.id) } : null
    if (!owner || !this.active(owner)) throw new AppError('App sign-in expired. Connect this server again.', 401)
    return owner
  }
  describeLogin(owner: Owner): DesktopLogin {
    const row = this.db
      .prepare('SELECT expires_at FROM logins WHERE id = ? AND user_id = ?')
      .get(owner.loginId, owner.userId)
    const identity = this.deployment.account(owner.userId)
    if (!row || !identity || !this.active(owner)) throw new AppError('App sign-in expired.', 401)
    return { account: identity.account, expiresAt: Number(row.expires_at) }
  }
  revoke(owner: Owner) {
    this.db.prepare('DELETE FROM logins WHERE id = ? AND user_id = ?').run(owner.loginId, owner.userId)
  }
}
