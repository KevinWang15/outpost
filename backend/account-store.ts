import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AccountUser } from '../shared/auth'
import { AppError } from './errors'

interface StoredUser extends AccountUser { passwordHash: string }
export interface AccountSession { id: string; user: AccountUser; expiresAt: number }
type Row = Record<string, unknown>
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const publicUser = (row: Row): AccountUser => ({
  id: String(row.id), name: String(row.name), email: String(row.email),
  emailVerifiedAt: row.verified_at ? String(row.verified_at) : null, createdAt: String(row.created_at),
})

export class AccountStore {
  private constructor(readonly directory: string, private db: DatabaseSync) {}

  static async open(directory: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const path = join(directory, 'accounts.sqlite')
    const db = new DatabaseSync(path)
    try {
      await chmod(path, 0o600)
      db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
          password_hash TEXT NOT NULL, verified_at TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(user_id);
        CREATE TABLE IF NOT EXISTS account_tokens (
          token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          purpose TEXT NOT NULL CHECK(purpose IN ('verify', 'reset')), expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS account_tokens_owner ON account_tokens(user_id, purpose);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `)
      db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('connection-secret', randomBytes(32).toString('hex'))
      const store = new AccountStore(directory, db)
      store.cleanup()
      return store
    } catch (error) { db.close(); throw error }
  }

  close() { this.db.close() }
  secret() { return String(this.db.prepare('SELECT value FROM settings WHERE key = ?').get('connection-secret')!.value) }
  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = action(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private stored(row: Row | undefined): StoredUser | null {
    return row ? { ...publicUser(row), passwordHash: String(row.password_hash) } : null
  }
  byEmail(email: string) { return this.stored(this.db.prepare('SELECT * FROM users WHERE email = ?').get(email)) }
  byId(id: string) { return this.stored(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id)) }
  profile(id: string): AccountUser | null {
    const row = this.db.prepare('SELECT id, name, email, verified_at, created_at FROM users WHERE id = ?').get(id)
    return row ? publicUser(row) : null
  }
  create(email: string, name: string, passwordHash: string): AccountUser {
    return this.transaction(() => {
      if (this.byEmail(email)) throw new AppError('This email is already registered. Sign in or reset your password.', 409)
      const id = randomUUID(), createdAt = new Date().toISOString()
      this.db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(id, email, name, passwordHash, createdAt)
      return { id, email, name, emailVerifiedAt: null, createdAt }
    })
  }
  updateName(id: string, name: string): AccountUser {
    this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id)
    const user = this.profile(id)
    if (!user) throw new AppError('Account not found', 404)
    return user
  }
  issueToken(userId: string, purpose: 'verify' | 'reset', ttl: number) {
    const token = randomBytes(32).toString('base64url')
    this.transaction(() => {
      this.db.prepare('DELETE FROM account_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose)
      this.db.prepare('INSERT INTO account_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)').run(hash(token), userId, purpose, Date.now() + ttl)
    })
    return token
  }
  consumeToken(token: string, purpose: 'verify' | 'reset', passwordHash?: string): AccountUser {
    return this.transaction(() => {
      const record = this.db.prepare('SELECT * FROM account_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > ?').get(hash(token), purpose, Date.now())
      if (!record) throw new AppError(`${purpose === 'verify' ? 'Verification' : 'Password reset'} link is invalid or expired. Request a new link.`, 400)
      this.db.prepare('DELETE FROM account_tokens WHERE token_hash = ?').run(hash(token))
      const verifiedAt = new Date().toISOString()
      if (purpose === 'reset') {
        if (!passwordHash) throw new Error('Missing new password hash')
        this.db.prepare('UPDATE users SET password_hash = ?, verified_at = COALESCE(verified_at, ?) WHERE id = ?').run(passwordHash, verifiedAt, record.user_id)
        this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(record.user_id)
        this.db.prepare('DELETE FROM account_tokens WHERE user_id = ?').run(record.user_id)
      } else this.db.prepare('UPDATE users SET verified_at = COALESCE(verified_at, ?) WHERE id = ?').run(verifiedAt, record.user_id)
      return publicUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(record.user_id)!)
    })
  }
  changePassword(userId: string, passwordHash: string, previousHash: string) {
    this.transaction(() => {
      if (this.byId(userId)?.passwordHash !== previousHash) throw new AppError('Your password changed. Sign in again before updating it.', 409)
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId)
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
      this.db.prepare('DELETE FROM account_tokens WHERE user_id = ?').run(userId)
    })
  }
  issueSession(user: AccountUser) {
    if (!user.emailVerifiedAt) throw new AppError('Verify your email before signing in.', 403)
    const token = randomBytes(32).toString('base64url'), id = randomUUID()
    const expiresAt = Date.now() + 30 * 24 * 60 * 60_000
    this.db.prepare('INSERT INTO sessions (id, token_hash, user_id, expires_at) VALUES (?, ?, ?, ?)').run(id, hash(token), user.id, expiresAt)
    return { token, id, expiresAt }
  }
  session(token: string): AccountSession | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    const row = this.db.prepare('SELECT users.*, sessions.id AS session_id, sessions.expires_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.verified_at IS NOT NULL').get(hash(token), Date.now())
    return row ? { id: String(row.session_id), user: publicUser(row), expiresAt: Number(row.expires_at) } : null
  }
  ticketSession(userId: string, sessionId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ? AND sessions.user_id = ? AND sessions.expires_at > ? AND users.verified_at IS NOT NULL').get(sessionId, userId, Date.now()))
  }
  revokeSession(token: string) { this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token)) }
  cleanup() {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
    this.db.prepare('DELETE FROM account_tokens WHERE expires_at <= ?').run(Date.now())
  }
}
