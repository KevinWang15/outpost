/** First-party native app login. Passwords and browser cookies never enter the app. */
export const desktopLoginLifetime = 30 * 24 * 60 * 60_000
export const desktopAuthorizationLifetime = 10 * 60_000
export const desktopProofPattern = '^[A-Za-z0-9_-]{43}$'
export const validDesktopProof = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)

export interface DesktopAccount {
  id: string
  name: string
  email: string | null
}
export interface DesktopLogin {
  account: DesktopAccount
  expiresAt: number
}
export interface DesktopCredential extends DesktopLogin {
  token: string
}
const text = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit
export function validDesktopLogin(value: unknown): value is DesktopLogin {
  if (!value || typeof value !== 'object') return false
  const login = value as DesktopLogin,
    account = login.account
  return (
    !!account &&
    validDesktopId(account.id) &&
    text(account.name, 512) &&
    (account.email === null || text(account.email, 254)) &&
    Number.isSafeInteger(login.expiresAt) &&
    login.expiresAt > 0
  )
}
export function validDesktopCredential(value: unknown): value is DesktopCredential {
  return (
    validDesktopLogin(value) &&
    'token' in value &&
    typeof value.token === 'string' &&
    /^op_app_[A-Za-z0-9_-]{43}$/.test(value.token)
  )
}
export interface DesktopAuthorization {
  requestId: string
  expiresAt: number
}
export interface DesktopTarget {
  id: string
  name: string
}
export interface DesktopSession {
  sessionId: string
  targetId: string
  title: string
  detail: string
}
export interface DesktopSessionReference {
  server: string
  accountId: string
  targetId: string
  sessionId: string
}
/** Stable routing identity is independent of the current login credential. */
export const desktopSessionId = (session: DesktopSessionReference) =>
  JSON.stringify([session.server, session.accountId, session.targetId, session.sessionId])
export interface DesktopSessionChoice extends DesktopSession, DesktopSessionReference {
  id: string
}

export function desktopLoginCallback(state: string, code: string) {
  return `outpost://login/${state}/${code}`
}
export function parseDesktopLoginCallback(value: string) {
  const match = /^outpost:\/\/login\/([A-Za-z0-9_-]{43})\/([A-Za-z0-9_-]{43}|denied)$/.exec(value)
  if (!match) throw new Error('Invalid Outpost sign-in callback.')
  return { state: match[1], code: match[2] }
}

/** A website hands off an address and optional session, never a credential. */
export interface DesktopEntry {
  server: string
  accountId: string
  session?: { targetId: string; sessionId: string }
}
export const validDesktopId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
export function desktopEntryUrl(entry: DesktopEntry): string {
  const url = new URL('outpost://server')
  url.searchParams.set('origin', desktopOrigin(entry.server))
  url.searchParams.set('account', entry.accountId)
  if (entry.session) {
    url.searchParams.set('target', entry.session.targetId)
    url.searchParams.set('session', entry.session.sessionId)
  }
  return url.href
}
export function parseDesktopEntry(value: string): DesktopEntry {
  if (value.length > 4096) throw new Error('Invalid Outpost app link.')
  const url = new URL(value),
    query = url.searchParams
  const accountId = query.get('account'),
    targetId = query.get('target'),
    sessionId = query.get('session')
  if (
    url.protocol !== 'outpost:' ||
    url.hostname !== 'server' ||
    url.pathname ||
    url.hash ||
    url.username ||
    url.password ||
    url.port ||
    [...query.keys()].some(
      key => !['origin', 'account', 'target', 'session'].includes(key) || query.getAll(key).length !== 1,
    ) ||
    !validDesktopId(accountId) ||
    ((targetId !== null || sessionId !== null) && (!validDesktopId(targetId) || !validDesktopId(sessionId)))
  )
    throw new Error('Invalid Outpost app link.')
  return {
    server: desktopOrigin(query.get('origin') ?? ''),
    accountId,
    ...(targetId && sessionId ? { session: { targetId, sessionId } } : {}),
  }
}

/** A session-scoped terminal grant obtained over authenticated HTTP. */
export interface DesktopLaunch extends DesktopSessionReference {
  loginId: string
  token: string
  title: string
}

/** Desktop privileges require HTTPS, except a server on this computer. */
export function desktopOrigin(value: string): string {
  if (value.length > 2048 || /[\s\\]/.test(value)) throw new Error('Enter an Outpost server URL.')
  const url = new URL(value)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Use an HTTPS server address, or HTTP on localhost, without a path or credentials.')
  return url.origin
}
