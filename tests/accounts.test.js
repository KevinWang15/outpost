import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Accounts } from '../backend/accounts.ts'
import { AccountStore } from '../backend/account-store.ts'
import { hashPassword, verifyPassword } from '../backend/account-passwords.ts'
import { accountEmail } from '../backend/account-email.ts'
import { createApp } from '../backend/app.ts'
import { sshArgs } from '../backend/ssh.ts'
import { SessionClient } from '../backend/sessions.ts'
import { SoftwareClient } from '../backend/software.ts'

const password = 'correct horse battery staple'
const targetInput = { kind: 'ssh', name: 'Development', host: 'dev.example.com', identityFile: '/manager/private-key', tools: ['codex'], backends: ['tmux'] }
const cookies = response => String(response.headers['set-cookie']).split(';')[0]
const token = url => new URL(url).searchParams.get('token')
const hash = value => createHash('sha256').update(value).digest('hex')
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-accounts-'))
  const messages = [], calls = []
  const production = options.production ?? false
  const publicUrl = production ? 'https://outpost.example' : 'http://127.0.0.1:5173'
  const open = () => Accounts.open({ directory, publicUrl, production, mailer: production ? async message => { messages.push(message) } : null, ...options })
  let accounts = await open()
  const service = { get: async (target, id) => { calls.push(target.id); return { id } }, list: async target => { calls.push(target.id); return { sessions: [] } } }
  let app = await createApp({ accounts, service })
  const request = (method, url, payload, cookie, extra = {}) => app.inject({ method, url, payload, headers: { host: new URL(publicUrl).host, 'x-outpost-request': '1', ...(cookie ? { cookie } : {}), ...extra } })
  async function signup(email, name = 'Dev') {
    const response = await request('POST', '/api/auth/signup', { email, name, password })
    assert.equal(response.statusCode, 201, response.body)
    return response.json()
  }
  async function member(email) {
    const result = await signup(email)
    const url = result.devUrl ?? messages.at(-1).html.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&')
    const response = await request('POST', '/api/auth/verify-email', { token: token(url) })
    assert.equal(response.statusCode, 200, response.body)
    return { cookie: cookies(response), user: response.json().user, response }
  }
  async function restart() { await app.close(); accounts = await open(); app = await createApp({ accounts, service }) }
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }) })
  return { request, signup, member, restart, directory, messages, calls, get accounts() { return accounts }, get app() { return app } }
}

test('password hashing is salted, fixed-cost, and rejects invalid values', async () => {
  const first = await hashPassword(password), second = await hashPassword(password)
  assert.notEqual(first, second)
  assert.equal(first.includes(password), false)
  assert.equal(await verifyPassword(password, first), true)
  assert.equal(await verifyPassword('wrong password', first), false)
  await assert.rejects(hashPassword('short'), /between 8/)
  await assert.rejects(hashPassword('x'.repeat(1025)), /between 8/)
  await assert.rejects(verifyPassword(password, 'scrypt$1$1$1$invalid'), /Invalid stored/)
})

test('hosted production requires HTTPS and configured email delivery', async () => {
  await assert.rejects(Accounts.open({ publicUrl: 'http://outpost.example', production: true }), /HTTPS/)
  await assert.rejects(Accounts.open({ publicUrl: 'https://outpost.example/path', production: true }), /origin/)
  const old = process.env.ENGAGE_LAB_API_KEY
  delete process.env.ENGAGE_LAB_API_KEY
  try { await assert.rejects(Accounts.open({ publicUrl: 'https://outpost.example', production: true }), /ENGAGE_LAB/) }
  finally { if (old !== undefined) process.env.ENGAGE_LAB_API_KEY = old }
})

test('signup, verification, sessions, logout, persistence, and private file permissions', async t => {
  const f = await fixture(t)
  assert.deepEqual((await f.request('GET', '/api/auth/session')).json(), { mode: 'hosted', user: null })
  for (const url of ['/api/targets', '/api/environment', '/api/account/ssh-key']) assert.equal((await f.request('GET', url)).statusCode, 401)
  for (const url of ['/%61pi/targets', '/api%2ftargets', '/api//targets', '/api/targets/../account/ssh-key']) {
    const response = await f.request('GET', url)
    assert.ok([401, 404].includes(response.statusCode), `${url}: ${response.body}`)
  }
  const created = await f.signup('Mixed@Example.com', ' Dev ')
  assert.equal(created.email, 'mixed@example.com')
  const value = token(created.devUrl)
  let response = await f.request('POST', '/api/auth/login', { email: created.email, password })
  assert.equal(response.statusCode, 403)
  assert.equal(response.json().code, 'EMAIL_NOT_VERIFIED')
  assert.equal((await f.request('POST', '/api/auth/signup', { email: 'MIXED@example.com', name: 'Again', password })).statusCode, 409)
  response = await f.request('POST', '/api/auth/verify-email', { token: value })
  assert.equal(response.statusCode, 200, response.body)
  const cookie = cookies(response), user = response.json().user
  assert.equal(user.name, 'Dev')
  assert.equal(user.passwordHash, undefined)
  assert.match(response.headers['set-cookie'], /HttpOnly/)
  assert.match(response.headers['set-cookie'], /SameSite=Lax/)
  assert.equal((await f.request('POST', '/api/auth/verify-email', { token: value })).statusCode, 400)
  assert.equal((await f.request('GET', '/api/auth/session', undefined, cookie)).json().user.id, user.id)
  assert.equal((await f.request('GET', '/api/targets', undefined, 'outpost_session=forged')).statusCode, 401)
  const db = new DatabaseSync(join(f.directory, 'accounts.sqlite'))
  const row = db.prepare('SELECT * FROM users').get()
  assert.match(row.password_hash, /^scrypt\$/)
  assert.notEqual(row.password_hash, password)
  assert.equal(db.prepare('SELECT * FROM sessions').get().token_hash, hash(cookie.split('=')[1]))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_tokens').get().n, 0)
  db.close()
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700)
    assert.equal((await stat(join(f.directory, 'accounts.sqlite'))).mode & 0o777, 0o600)
  }
  await f.restart()
  assert.equal((await f.request('GET', '/api/auth/session', undefined, cookie)).json().user.id, user.id)
  const saved = await f.request('PATCH', '/api/account/profile', { name: 'Renamed' }, cookie)
  assert.equal(saved.json().user.name, 'Renamed')
  assert.equal(saved.json().user.passwordHash, undefined)
  assert.equal((await f.request('POST', '/api/auth/logout', undefined, cookie)).statusCode, 204)
  assert.equal((await f.request('GET', '/api/targets', undefined, cookie)).statusCode, 401)
  response = await f.request('POST', '/api/auth/login', { email: created.email, password })
  assert.equal(response.statusCode, 200, response.body)
  assert.notEqual(cookies(response), cookie)
})

test('verification reissue invalidates old tokens, concurrent claims are single use, and expiry is enforced', async t => {
  const f = await fixture(t)
  const signup = await f.signup('verify@example.com')
  const resent = (await f.request('POST', '/api/auth/resend-verification', { email: signup.email })).json()
  assert.equal((await f.request('POST', '/api/auth/verify-email', { token: token(signup.devUrl) })).statusCode, 400)
  const claims = await Promise.all([1, 2].map(() => f.request('POST', '/api/auth/verify-email', { token: token(resent.devUrl) })))
  assert.deepEqual(claims.map(response => response.statusCode).sort(), [200, 400])
  const user = f.accounts.store.byEmail(signup.email)
  const expired = f.accounts.store.issueToken(user.id, 'reset', -1)
  assert.throws(() => f.accounts.store.consumeToken(expired, 'reset', 'hash'), /expired/)
  const db = new DatabaseSync(join(f.directory, 'accounts.sqlite'))
  db.prepare('UPDATE sessions SET expires_at = 0').run(); db.close()
  assert.equal((await f.request('GET', '/api/targets', undefined, cookies(claims.find(response => response.statusCode === 200)))).statusCode, 401)
})

test('password recovery and changes revoke every session and issued connection ticket', async t => {
  const f = await fixture(t)
  const owner = await f.member('recover@example.com')
  const otherDevice = await f.request('POST', '/api/auth/login', { email: owner.user.email, password })
  const target = (await f.request('POST', '/api/targets', targetInput, owner.cookie)).json()
  const connection = (await f.request('POST', `/api/targets/${target.id}/sessions/work/connect`, undefined, owner.cookie)).json()
  const link = new URL(connection.commands.bash.match(/'(http[^']+)'/)[1]).pathname
  assert.equal((await f.request('GET', link)).statusCode, 200)
  const reset = (await f.request('POST', '/api/auth/forgot-password', { email: owner.user.email })).json()
  const unknown = (await f.request('POST', '/api/auth/forgot-password', { email: 'unknown@example.com' })).json()
  assert.equal(reset.message, unknown.message)
  const input = { token: token(reset.devUrl), password: 'a completely new password' }
  assert.equal((await f.request('POST', '/api/auth/reset-password', input)).statusCode, 200)
  assert.equal((await f.request('POST', '/api/auth/reset-password', input)).statusCode, 400)
  for (const cookie of [owner.cookie, cookies(otherDevice)]) assert.equal((await f.request('GET', '/api/targets', undefined, cookie)).statusCode, 401)
  assert.equal((await f.request('GET', link)).statusCode, 403)
  assert.equal((await f.request('POST', '/api/auth/login', { email: owner.user.email, password })).statusCode, 401)
  const login = await f.request('POST', '/api/auth/login', { email: owner.user.email, password: input.password })
  assert.equal(login.statusCode, 200)
  const cookie = cookies(login)
  assert.equal((await f.request('POST', '/api/account/password', { currentPassword: 'incorrect', password }, cookie)).statusCode, 400)
  assert.equal((await f.request('POST', '/api/account/password', { currentPassword: input.password, password }, cookie)).statusCode, 200)
  assert.equal((await f.request('GET', '/api/targets', undefined, cookie)).statusCode, 401)
  assert.equal((await f.request('POST', '/api/auth/login', { email: owner.user.email, password })).statusCode, 200)
})

test('users own separate targets and SSH identities; foreign IDs never reach services', async t => {
  const f = await fixture(t)
  const alice = await f.member('alice@example.com'), bob = await f.member('bob@example.com')
  const first = (await f.request('POST', '/api/targets', targetInput, alice.cookie)).json()
  const second = (await f.request('POST', '/api/targets', targetInput, bob.cookie)).json()
  const base = `/api/targets/${first.id}`
  assert.deepEqual((await f.request('GET', '/api/targets', undefined, alice.cookie)).json().map(target => target.id), [first.id])
  assert.deepEqual((await f.request('GET', '/api/targets', undefined, bob.cookie)).json().map(target => target.id), [second.id])
  const endpoints = [
    ['GET', '/software'], ['GET', '/software/tmux/script'], ['GET', '/installations'], ['GET', '/installations/missing/events'],
    ['GET', '/sessions'], ['GET', '/sessions/work'], ['GET', '/directories?path=/'], ['DELETE', ''],
    ['PATCH', '/requirements', { tools: ['codex'], backends: ['tmux'] }], ['POST', '/installations', { softwareId: 'tmux', script: 'echo test' }],
    ['POST', '/sessions', { name: 'Work', tool: 'codex', backend: 'tmux', rootDir: '/root' }],
    ['POST', '/coding-sessions/search', { query: 'private' }], ['POST', '/sessions/work/connect'],
    ['DELETE', '/sessions/work'], ['POST', '/sessions/work/terminate'], ['POST', '/sessions/work/acknowledge', { completionId: 'a'.repeat(64) }],
    ['POST', '/sessions/work/image', { mediaType: 'image/png', data: 'aGVsbG8=' }],
  ]
  for (const [method, path, payload] of endpoints) {
    const response = await f.request(method, base + path, payload, bob.cookie)
    assert.equal(response.statusCode, 404, `${method} ${path}: ${response.body}`)
  }
  assert.deepEqual(f.calls, [])
  const aKey = (await f.request('GET', '/api/account/ssh-key', undefined, alice.cookie)).json()
  const bKey = (await f.request('GET', '/api/account/ssh-key', undefined, bob.cookie)).json()
  assert.notEqual(aKey.publicKey, bKey.publicKey)
  assert.match(aKey.fingerprint, /^SHA256:/)
  assert.deepEqual(Object.keys(aKey).sort(), ['fingerprint', 'publicKey'])
  const target = await f.accounts.targetStore(alice.user.id).get(first.id)
  const args = sshArgs(target)
  assert.ok(args.includes('none'))
  assert.ok(args.includes('IdentityAgent=none'))
  assert.ok(args.includes('IdentitiesOnly=yes'))
  assert.ok(args.includes(f.accounts.keys.paths(alice.user.id).identityFile))
  assert.ok(!args.includes(targetInput.identityFile), 'user input cannot select a manager private key')
  assert.ok(sshArgs(target, true).includes(targetInput.identityFile), 'copy command uses client-side identity')
  const unscoped = { ...target }
  await assert.rejects(new SessionClient(process.env, true).list(unscoped), /Account SSH access is unavailable/)
  await assert.rejects(new SoftwareClient(process.env, true).inspect(unscoped), /Account SSH access is unavailable/)
  assert.equal((await f.request('POST', '/api/targets', { kind: 'local', name: 'Manager', tools: ['codex'], backends: ['tmux'] }, alice.cookie)).statusCode, 400)
  assert.equal((await f.request('POST', `${base}/sessions/work/launch`, {}, alice.cookie)).statusCode, 403)
  assert.equal((await f.request('GET', '/api/environment', undefined, alice.cookie)).json().supported, false)
  await f.restart()
  assert.equal((await f.request('GET', '/api/account/ssh-key', undefined, alice.cookie)).json().publicKey, aKey.publicKey)
  assert.equal((await f.request('GET', '/api/targets', undefined, alice.cookie)).json()[0].id, first.id)
  const privateKey = await readFile(f.accounts.keys.paths(alice.user.id).identityFile, 'utf8')
  assert.match(privateKey, /BEGIN OPENSSH PRIVATE KEY/)
})

test('production cookies, host/origin checks, bearer ticket integrity, and logout revocation', async t => {
  const f = await fixture(t, { production: true })
  const owner = await f.member('secure@example.com')
  assert.match(owner.response.headers['set-cookie'], /Secure/)
  assert.equal(f.messages.length, 1)
  assert.equal((await f.request('POST', '/api/auth/forgot-password', { email: owner.user.email })).json().devUrl, undefined)
  for (const headers of [{ origin: 'https://evil.example' }, { host: 'evil.example' }, { 'x-outpost-request': '' }]) {
    assert.equal((await f.request('POST', '/api/auth/logout', undefined, owner.cookie, headers)).statusCode, 403)
  }
  assert.equal((await f.app.inject({ url: '/api/auth/session', remoteAddress: '203.0.113.5', headers: { host: 'outpost.example' } })).statusCode, 200)
  const target = (await f.request('POST', '/api/targets', targetInput, owner.cookie)).json()
  assert.equal((await f.request('GET', '/api/auth/session', undefined, owner.cookie, { host: 'outpost.example:443' })).statusCode, 200)
  const connection = (await f.request('POST', `/api/targets/${target.id}/sessions/work/connect`, undefined, owner.cookie, { host: 'outpost.example:8443' })).json()
  // Unexpected ports do not match the configured public authority.
  assert.equal(connection.message, 'Use the configured Outpost address.')
  const valid = (await f.request('POST', `/api/targets/${target.id}/sessions/work/connect`, undefined, owner.cookie)).json()
  assert.equal(valid.hosted, true)
  assert.deepEqual(valid.desktop.terminals, [])
  const url = new URL(valid.commands.bash.match(/'(https[^']+)'/)[1])
  assert.equal(url.origin, 'https://outpost.example')
  assert.equal((await f.request('GET', url.pathname)).statusCode, 200)
  const ticket = url.pathname.split('/').at(-1)
  const claims = JSON.parse(Buffer.from(ticket.split('.')[0], 'base64url'))
  assert.equal(claims.userId, owner.user.id)
  const tampered = Buffer.from(JSON.stringify({ ...claims, userId: '00000000-0000-0000-0000-000000000000' })).toString('base64url')
  assert.equal((await f.request('GET', `/api/connect/${tampered}.${ticket.split('.')[1]}`)).statusCode, 403)
  const legacy = Buffer.from(JSON.stringify({ targetId: target.id, sessionId: 'work', expires: Date.now() + 10000, shell: 'bash' })).toString('base64url')
  const signature = createHmac('sha256', f.accounts.store.secret()).update(legacy).digest('base64url')
  assert.equal((await f.request('GET', `/api/connect/${legacy}.${signature}`)).statusCode, 403)
  await f.request('POST', '/api/auth/logout', undefined, owner.cookie)
  assert.equal((await f.request('GET', url.pathname)).statusCode, 403)
})

test('local development links are loopback-only; production delivery failure does not expose tokens', async t => {
  const local = await fixture(t)
  assert.equal((await local.app.inject({ url: '/api/auth/session', remoteAddress: '203.0.113.5', headers: { host: '127.0.0.1' } })).statusCode, 403)
  const failing = await fixture(t, { production: true, mailer: async () => { throw new Error('provider secret') } })
  const result = await failing.signup('undelivered@example.com')
  assert.match(result.message, /could not be delivered/)
  assert.equal(result.devUrl, undefined)
  assert.equal(JSON.stringify(result).includes('provider secret'), false)
  const forgot = await failing.request('POST', '/api/auth/forgot-password', { email: result.email })
  const unknown = await failing.request('POST', '/api/auth/forgot-password', { email: 'unknown@example.com' })
  assert.deepEqual(forgot.json(), unknown.json())
})

test('invalid signup data is rejected and account email content is escaped', async t => {
  const f = await fixture(t)
  for (const extra of [{ email: 'invalid' }, { name: ' ' }, { name: 'line\nbreak' }, { password: 'short' }, { password: 'x'.repeat(1025) }, { role: 'admin' }]) {
    const response = await f.request('POST', '/api/auth/signup', { email: 'invalid@example.com', name: 'Dev', password, ...extra })
    assert.equal(response.statusCode, 400, response.body)
  }
  const message = accountEmail('<script>bad</script>', 'dev@example.com', 'https://outpost.example/?a=1&b=2', 'verify')
  assert.equal(message.html.includes('<script>'), false)
  assert.match(message.html, /&lt;script&gt;/)
  assert.match(message.html, /a=1&amp;b=2/)
})

test('account request limits cap repeated attempts', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 5; i++) assert.equal((await f.request('POST', '/api/auth/forgot-password', { email: 'none@example.com' })).statusCode, 200)
  assert.equal((await f.request('POST', '/api/auth/forgot-password', { email: 'none@example.com' })).statusCode, 429)
})

test('a password reset during password verification prevents an old-password login from completing', async t => {
  const f = await fixture(t)
  const owner = await f.member('race@example.com')
  const replacement = await hashPassword('replacement after reset')
  const lookup = f.accounts.store.byEmail.bind(f.accounts.store)
  f.accounts.store.byEmail = email => {
    const snapshot = lookup(email)
    queueMicrotask(() => f.accounts.store.changePassword(snapshot.id, replacement, snapshot.passwordHash))
    return snapshot
  }
  try {
    const result = await f.request('POST', '/api/auth/login', { email: owner.user.email, password })
    assert.equal(result.statusCode, 401)
    assert.equal(result.headers['set-cookie'], undefined)
    assert.equal((await f.request('GET', '/api/targets', undefined, owner.cookie)).statusCode, 401)
  } finally { f.accounts.store.byEmail = lookup }
  assert.equal((await f.request('POST', '/api/auth/login', { email: owner.user.email, password: 'replacement after reset' })).statusCode, 200)
})

test('store tokens are hashed and reset tokens cannot be used for email verification', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-account-store-'))
  const store = await AccountStore.open(directory)
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }) })
  const user = store.create('store@example.com', 'Dev', 'unused hash')
  const value = store.issueToken(user.id, 'reset', 10000)
  const db = new DatabaseSync(join(directory, 'accounts.sqlite'))
  assert.equal(db.prepare('SELECT token_hash FROM account_tokens').get().token_hash, hash(value))
  db.close()
  assert.throws(() => store.consumeToken(value, 'verify'), /invalid or expired/)
  assert.equal(store.byId(user.id).emailVerifiedAt, null)
})
