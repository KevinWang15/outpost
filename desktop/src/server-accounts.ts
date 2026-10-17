import {
  desktopOrigin,
  validDesktopLogin,
  type DesktopEntry,
  type DesktopSessionReference,
} from '../../shared/desktopAuth'
import type { ServerTrust } from './server-trust'
import type { ServerAccountsSnapshot, ServerConnection } from './server-accounts-api'
import { ServerApiError, serverRequest, requestQueue } from './server-api'
import { parseDesktopLaunch } from './launch'
import { ServerLoginStore, type SavedServerLogin } from './server-login-store'
import { ServerSignIn } from './server-sign-in'
import { loadSessionCatalogue, type SessionCatalogue } from './server-catalogue'
import { sessionCreationServer } from './server-session-creation'

interface Host {
  openBrowser(url: string): Promise<void>
  changed(): void
  failed(error: Error): void
}
type Connection = { entry: SavedServerLogin; status: ServerConnection; error: string | null }

/** Owns saved server accounts and their authorization lifetime. Browser sign-in,
 * origin trust and session discovery each have a separate, narrow owner. */
export class ServerAccounts {
  private store: ServerLoginStore
  private signIn: ServerSignIn
  private connections = new Map<string, Connection>()
  private signingOut = new Map<string, Promise<boolean>>()
  private lifetime = new AbortController()
  private refreshWork: Promise<void> | null = null
  constructor(
    path: string,
    private trust: ServerTrust,
    private host: Host,
  ) {
    this.store = new ServerLoginStore(path)
    this.signIn = new ServerSignIn(this.store, {
      ...host,
      accepted: entry => this.connection(entry, 'connected'),
    })
  }
  load() {
    return this.store.load(origin => this.trust.has(origin))
  }
  snapshot(): ServerAccountsSnapshot {
    return {
      accounts: this.store.list().map(entry => {
        const state = this.connections.get(entry.origin)
        const status = this.signingOut.has(entry.origin)
          ? 'signing-out'
          : entry.expiresAt <= Date.now()
            ? 'expired'
            : state?.entry === entry
              ? state.status
              : 'offline'
        return {
          origin: entry.origin,
          account: entry.account,
          expiresAt: entry.expiresAt,
          status,
          error:
            status === 'expired'
              ? 'Sign-in expired. Connect this server again.'
              : state?.entry === entry
                ? state.error
                : null,
        }
      }),
      signIns: this.signIn.snapshot(),
    }
  }
  private connection(entry: SavedServerLogin, status: ServerConnection, error: string | null = null) {
    if (!this.current(entry)) return
    const previous = this.connections.get(entry.origin)
    // Concurrent requests cannot revive a credential after any request rejected it.
    if (previous?.entry === entry && previous.status === 'expired' && status !== 'expired') return
    this.connections.set(entry.origin, { entry, status, error })
    this.host.changed()
  }
  private current(entry: SavedServerLogin) {
    return !this.lifetime.signal.aborted && !this.signingOut.has(entry.origin) && this.store.get(entry.origin) === entry
  }
  private valid(entry: SavedServerLogin) {
    const connection = this.connections.get(entry.origin)
    return (
      this.current(entry) &&
      entry.expiresAt > Date.now() &&
      !(connection?.entry === entry && connection.status === 'expired')
    )
  }
  private require(entry: SavedServerLogin) {
    if (!this.current(entry)) throw new Error('The server account changed. Connect again.')
    if (!this.valid(entry)) {
      this.connection(entry, 'expired')
      throw new ServerApiError('Sign in to this server from the Outpost tab.', 401)
    }
  }
  hasAccount(server: string, accountId: string) {
    return this.store.get(server)?.account.id === accountId
  }
  /** All credential-bearing requests use one ownership, expiry and error boundary. */
  private async request(
    entry: SavedServerLogin,
    path: string,
    options: { signal?: AbortSignal; method?: string; body?: unknown } = {},
  ) {
    this.require(entry)
    const signal = options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal
    try {
      const result = await serverRequest(entry.origin, path, { ...options, signal, token: entry.token })
      this.require(entry)
      this.connection(entry, 'connected')
      return result
    } catch (error) {
      if (!signal.aborted && this.current(entry)) {
        if (error instanceof ServerApiError && error.status === 401) this.connection(entry, 'expired')
        else if (!(error instanceof ServerApiError))
          this.connection(entry, 'offline', error instanceof Error ? error.message : 'Could not contact this server.')
      }
      throw error
    }
  }
  private async check(entry: SavedServerLogin) {
    this.require(entry)
    this.connection(entry, 'checking')
    try {
      const login = await this.request(entry, '/account')
      if (!validDesktopLogin(login) || login.account.id !== entry.account.id)
        throw new Error('Invalid server account response.')
    } catch (error) {
      if (!(error instanceof ServerApiError && error.status === 401))
        this.connection(entry, 'offline', error instanceof Error ? error.message : 'Could not contact this server.')
      throw error
    }
  }
  /** Both user entry points reuse a current account or start the same browser approval. */
  async connect(intent: DesktopEntry) {
    const origin = desktopOrigin(intent.server)
    await this.signingOut.get(origin)
    this.lifetime.signal.throwIfAborted()
    const entry = this.store.get(origin)
    if (entry?.account.id === intent.accountId && this.valid(entry)) {
      try {
        if (intent.session) return await this.launch({ ...intent.session, server: origin, accountId: intent.accountId })
        await this.check(entry)
        return null
      } catch (error) {
        if (!(error instanceof ServerApiError && error.status === 401)) throw error
      }
    }
    await this.startSignIn(origin, intent)
    return null
  }
  async login(value: string) {
    const origin = desktopOrigin(value)
    await this.signingOut.get(origin)
    this.lifetime.signal.throwIfAborted()
    const entry = this.store.get(origin)
    if (entry && this.valid(entry)) {
      try {
        await this.check(entry)
        return
      } catch (error) {
        if (!(error instanceof ServerApiError && error.status === 401)) throw error
      }
    }
    await this.startSignIn(origin)
  }
  private async startSignIn(origin: string, intent?: DesktopEntry) {
    if (!(await this.trust.ensure(origin))) return
    this.lifetime.signal.throwIfAborted()
    // Sign-out can start while a native trust dialog is open.
    await this.signingOut.get(origin)
    this.lifetime.signal.throwIfAborted()
    await this.signIn.start(origin, intent)
  }
  cancel(value: string) {
    this.signIn.cancel(desktopOrigin(value))
  }
  complete(value: string) {
    return this.signIn.complete(value)
  }
  logout(value: string): Promise<boolean> {
    const origin = desktopOrigin(value)
    const pending = this.signingOut.get(origin)
    if (pending) return pending
    const work = this.signOut(origin).finally(() => {
      if (this.signingOut.get(origin) === work) this.signingOut.delete(origin)
      this.host.changed()
    })
    this.signingOut.set(origin, work)
    this.host.changed()
    return work
  }
  private async signOut(origin: string) {
    await this.signIn.stop(origin)
    const entry = this.store.get(origin)
    if (!entry) return true
    try {
      await serverRequest(origin, '/logout', { token: entry.token, method: 'POST', signal: this.lifetime.signal })
    } catch (error) {
      if (!(error instanceof ServerApiError && error.status === 401))
        throw new Error('Could not sign out on this server. Check your connection and try again.', { cause: error })
    }
    await this.store.remove(entry)
    this.connections.delete(origin)
    return this.store.get(origin) === undefined
  }
  refresh() {
    if (this.refreshWork) return this.refreshWork
    const queue = requestQueue(4)
    this.refreshWork = Promise.all(
      this.store
        .list()
        .filter(entry => this.current(entry))
        .map(entry => queue(() => this.check(entry)).catch(() => {})),
    )
      .then(() => {})
      .finally(() => {
        this.refreshWork = null
      })
    return this.refreshWork
  }
  sessions(signal: AbortSignal, publish: (catalogue: SessionCatalogue) => void) {
    signal = AbortSignal.any([signal, this.lifetime.signal])
    return loadSessionCatalogue(
      this.store.list().map(entry => ({
        origin: entry.origin,
        accountId: entry.account.id,
        current: () => this.valid(entry),
        request: (path, signal) => this.request(entry, path, { signal }),
      })),
      signal,
      publish,
    )
  }
  creationServers() {
    return this.store
      .list()
      .filter(entry => this.valid(entry))
      .map(entry =>
        sessionCreationServer({ origin: entry.origin, account: entry.account }, (path, options) =>
          this.request(entry, path, options),
        ),
      )
  }
  async launch(session: DesktopSessionReference) {
    const entry = this.store.get(session.server)
    if (!entry || entry.account.id !== session.accountId)
      throw new Error('Sign in to the server account that owns this session.')
    const launch = parseDesktopLaunch(
      await this.request(
        entry,
        `/targets/${encodeURIComponent(session.targetId)}/sessions/${encodeURIComponent(session.sessionId)}/connect`,
        { method: 'POST' },
      ),
    )
    if (
      launch.server !== session.server ||
      launch.accountId !== session.accountId ||
      launch.targetId !== session.targetId ||
      launch.sessionId !== session.sessionId
    )
      throw new Error('The server returned a different session. Connect again.')
    return launch
  }
  flush() {
    return this.signIn.flush()
  }
  dispose() {
    this.lifetime.abort()
    this.signIn.dispose()
  }
}
