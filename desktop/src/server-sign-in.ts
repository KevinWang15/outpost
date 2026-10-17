import { createHash, randomBytes } from 'node:crypto'
import { pagePaths } from '../../shared/pages'
import {
  desktopAuthorizationLifetime,
  desktopSessionId,
  parseDesktopLoginCallback,
  validDesktopCredential,
  validDesktopProof,
  type DesktopEntry,
  type DesktopSessionReference,
} from '../../shared/desktopAuth'
import type { ServerSignInSummary, SignInPhase } from './server-accounts-api'
import { serverRequest } from './server-api'
import { ServerLoginStore, type SavedServerLogin } from './server-login-store'

interface Attempt {
  origin: string
  accountId?: string
  state: string | null
  verifier: string
  sessions: Map<string, DesktopSessionReference>
  phase: SignInPhase
  abort: AbortController
  timer: NodeJS.Timeout
  exchange?: Promise<DesktopSessionReference[] | undefined>
}
interface Host {
  openBrowser(url: string): Promise<void>
  changed(): void
  accepted(entry: SavedServerLogin): void
  failed(error: Error): void
}

/** Pending browser authorizations. Saving is the commit point: cancellation is
 * available before it, and sign-out waits for it before revoking the login. */
export class ServerSignIn {
  private attempts = new Map<string, Attempt>()
  private closed = false
  constructor(
    private store: ServerLoginStore,
    private host: Host,
  ) {}
  snapshot(): ServerSignInSummary[] {
    return [...this.attempts.values()].map(({ origin, phase }) => ({ origin, phase }))
  }
  private phase(attempt: Attempt, phase: SignInPhase) {
    attempt.phase = phase
    this.host.changed()
  }
  private current(attempt: Attempt) {
    return this.attempts.get(attempt.origin) === attempt && !attempt.abort.signal.aborted
  }
  private finish(attempt: Attempt) {
    clearTimeout(attempt.timer)
    if (this.attempts.get(attempt.origin) !== attempt) return
    this.attempts.delete(attempt.origin)
    this.host.changed()
  }
  async start(origin: string, intent?: DesktopEntry) {
    if (this.closed) return
    const existing = this.attempts.get(origin)
    if (existing) {
      if (intent && existing.accountId !== intent.accountId)
        throw new Error('Finish or cancel the pending sign-in before connecting from another account.')
      this.addSession(existing, intent)
      return
    }
    if (this.attempts.size >= 16) throw new Error('Finish or cancel a pending sign-in before starting another.')
    const attempt: Attempt = {
      origin,
      accountId: intent?.accountId,
      state: randomBytes(32).toString('base64url'),
      verifier: randomBytes(32).toString('base64url'),
      sessions: new Map(),
      phase: 'opening',
      abort: new AbortController(),
      timer: setTimeout(() => {
        this.cancel(origin)
        this.host.failed(new Error(`Browser sign-in to ${origin} timed out. Connect again to retry.`))
      }, desktopAuthorizationLifetime).unref(),
    }
    this.addSession(attempt, intent)
    this.attempts.set(origin, attempt)
    this.host.changed()
    try {
      const response = (await serverRequest(origin, '/authorizations', {
        body: {
          accountId: attempt.accountId,
          state: attempt.state,
          challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
        },
        signal: attempt.abort.signal,
      })) as { requestId?: unknown }
      if (!validDesktopProof(response?.requestId)) throw new Error('Invalid server authorization response.')
      if (!this.current(attempt)) return
      const url = new URL(pagePaths.desktopAuthorize, origin)
      url.searchParams.set('request', response.requestId)
      await this.host.openBrowser(url.href)
      if (this.current(attempt) && attempt.phase === 'opening') this.phase(attempt, 'waiting')
    } catch (error) {
      if (!this.current(attempt)) return
      this.finish(attempt)
      throw error
    }
  }
  private addSession(attempt: Attempt, intent?: DesktopEntry) {
    if (!intent?.session) return
    const reference = { server: intent.server, accountId: intent.accountId, ...intent.session }
    const id = desktopSessionId(reference)
    if (attempt.sessions.size >= 16 && !attempt.sessions.has(id))
      throw new Error('Too many sessions waiting for sign-in.')
    attempt.sessions.set(id, reference)
  }
  cancel(origin: string) {
    const attempt = this.attempts.get(origin)
    if (!attempt || attempt.phase === 'saving') return
    attempt.abort.abort()
    this.finish(attempt)
  }
  complete(value: string): Promise<DesktopSessionReference[] | undefined> {
    const callback = parseDesktopLoginCallback(value)
    const attempt = [...this.attempts.values()].find(item => item.state === callback.state)
    if (!attempt) throw new Error('This app sign-in is no longer pending. Connect the server again.')
    if (callback.code === 'denied') {
      this.cancel(attempt.origin)
      return Promise.resolve(undefined)
    }
    attempt.state = null
    this.phase(attempt, 'exchanging')
    attempt.exchange = this.exchange(attempt, callback.code)
    return attempt.exchange
  }
  private async exchange(attempt: Attempt, code: string) {
    let credential: SavedServerLogin | undefined
    let saved = false
    try {
      const result = await serverRequest(attempt.origin, '/token', {
        body: { code, verifier: attempt.verifier },
        signal: attempt.abort.signal,
      })
      if (!validDesktopCredential(result) || result.expiresAt <= Date.now())
        throw new Error('Invalid app login response.')
      credential = {
        origin: attempt.origin,
        token: result.token,
        expiresAt: result.expiresAt,
        account: { id: result.account.id, name: result.account.name, email: result.account.email },
      }
      if (!this.current(attempt)) return
      if (attempt.accountId && credential.account.id !== attempt.accountId)
        throw new Error('Sign in with the same browser account as the website that opened the app.')
      const previous = this.store.get(attempt.origin)
      // No await between checking cancellation and entering the durable commit.
      clearTimeout(attempt.timer)
      this.phase(attempt, 'saving')
      await this.store.put(credential)
      saved = true
      this.host.accepted(credential)
      if (previous) void this.revokeUnused(previous)
      return [...attempt.sessions.values()]
    } catch (error) {
      if (attempt.abort.signal.aborted) return
      throw error
    } finally {
      this.finish(attempt)
      if (credential && !saved) await this.revokeUnused(credential)
    }
  }
  private async revokeUnused(entry: SavedServerLogin) {
    // Unaccepted credentials are never persisted; server expiry also bounds their lifetime.
    await serverRequest(entry.origin, '/logout', { token: entry.token, method: 'POST' }).catch(() => {})
  }
  async stop(origin: string) {
    const attempt = this.attempts.get(origin)
    this.cancel(origin)
    await attempt?.exchange?.catch(() => {})
  }
  async flush() {
    await Promise.allSettled(
      [...this.attempts.values()].filter(item => item.phase === 'saving').map(item => item.exchange),
    )
    await this.store.flush()
  }
  dispose() {
    this.closed = true
    for (const origin of this.attempts.keys()) this.cancel(origin)
  }
}
