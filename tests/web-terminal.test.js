import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import ssh2 from 'ssh2'
import { WebSocket } from 'ws'
import { TerminalKeys } from '../backend/terminal-keys.ts'
import { createApp } from '../backend/app.ts'
import { Accounts } from '../backend/accounts.ts'
import { TargetStore } from '../backend/store.ts'
import { webSshFixture } from './fixtures/web-ssh.ts'

async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(30) }; assert.fail('condition timed out') }
async function connect(origin, id, cookie, extra = {}) {
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/api/web-terminals/${id}/socket`, { headers: { origin, cookie, ...extra } })
  const messages = [], output = []
  ws.on('error', () => {})
  ws.on('message', (bytes, binary) => {
    if (binary) { output.push(bytes.toString()); ws.send(JSON.stringify({ type: 'ack', bytes: bytes.length })) }
    else { const message = JSON.parse(bytes); messages.push(message); if (message.type === 'snapshot') ws.send(JSON.stringify({ type: 'ack', bytes: Buffer.byteLength(message.data) })) }
  })
  await once(ws, 'open'); await until(() => messages.some(item => item.type === 'snapshot'))
  return { ws, messages, output, send: message => ws.send(JSON.stringify(message)) }
}

test('terminal vault encrypts keys, discards passphrases, authenticates ownership, supports encrypted keys, and pins host identity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-key-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const master = randomBytes(32).toString('base64'), vault = new TerminalKeys(directory, true, master)
  const keys = ssh2.utils.generateKeyPairSync('ed25519', { passphrase: 'synthetic-secret', cipher: 'aes256-cbc' })
  await assert.rejects(vault.upload('alice', 'target', keys.public), /private key/)
  await assert.rejects(vault.upload('alice', 'target', keys.private, 'wrong'), /private key/)
  const info = await vault.upload('alice', 'target', keys.private, 'synthetic-secret')
  assert.match(info.fingerprint, /^SHA256:/)
  const dir = join(directory, 'terminal-keys'), file = (await readdir(dir)).find(name => name.endsWith('.json')), path = join(dir, file)
  const encrypted = await readFile(path, 'utf8')
  assert.equal(encrypted.includes('synthetic-secret'), false); assert.equal(encrypted.includes('PRIVATE KEY'), false)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.equal((await stat(dir)).mode & 0o777, 0o700)
  assert.equal((await vault.status('bob', 'target')).key, null)
  const forged = join(dir, `${createHash('sha256').update(JSON.stringify(['bob', 'target'])).digest('hex')}.json`)
  await writeFile(forged, encrypted)
  await assert.rejects(vault.read('bob', 'target'), /cannot be decrypted/, 'ciphertext cannot be moved to another account')
  await vault.remove('bob', 'target')
  const restored = await new TerminalKeys(directory, true, master).read('alice', 'target')
  assert.ok(ssh2.utils.parseKey(restored.privateKey).getPublicSSH().equals(ssh2.utils.parseKey(keys.public).getPublicSSH()))
  assert.equal(restored.passphrase, '', 'the passphrase unlocks the uploaded key once and is discarded')
  const host = ssh2.utils.parseKey(ssh2.utils.generateKeyPairSync('ed25519').public).getPublicSSH()
  assert.equal(await vault.verifyHost('alice', 'target', restored, host, []), true)
  assert.equal(await vault.verifyHost('alice', 'target', restored, Buffer.from('different'), []), false)
  assert.equal(await vault.verifyHost('alice', 'target', restored, host, [Buffer.from('different').toString('base64')]), false)
  assert.match((await vault.status('alice', 'target')).key.hostFingerprint, /^SHA256:/)
  await vault.upload('alice', 'target', keys.private, 'synthetic-secret')
  assert.equal((await vault.read('alice', 'target')).hostKey, host.toString('base64'), 'replacement keeps the host pin')
  const wrongMaster = new TerminalKeys(directory, true, randomBytes(32).toString('base64'))
  await assert.rejects(wrongMaster.read('alice', 'target'), /cannot be decrypted/)
  const corrupt = JSON.parse(await readFile(path, 'utf8')); corrupt.tag = randomBytes(16).toString('base64')
  await writeFile(path, JSON.stringify(corrupt)); await assert.rejects(vault.read('alice', 'target'), /cannot be decrypted/)
  await vault.remove('alice', 'target'); assert.equal((await vault.status('alice', 'target')).key, null)
  assert.equal((await new TerminalKeys(directory, true, '').status('alice', 'target')).encryptionAvailable, false)
  await assert.rejects(new TerminalKeys(directory, true, '').upload('alice', 'target', keys.private), /administrator/)
})

test('uploaded RSA and ECDSA keys normalize without passphrases and preserve their public identity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-key-formats-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const vault = new TerminalKeys(directory)
  for (const type of ['rsa', 'ecdsa']) {
    const key = ssh2.utils.generateKeyPairSync(type, { ...(type === 'rsa' ? { bits: 2048 } : { bits: 256 }), passphrase: 'synthetic-secret', cipher: 'aes256-cbc' })
    await vault.upload('alice', type, key.private, 'synthetic-secret')
    const saved = await vault.read('alice', type)
    assert.equal(saved.passphrase, '')
    assert.ok(ssh2.utils.parseKey(saved.privateKey).getPublicSSH().equals(ssh2.utils.parseKey(key.public).getPublicSSH()))
  }
})

test('real SSH web terminal: explicit launch, private credentials, origin/auth checks, resize, reconnect, revocation and cleanup', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-web-ssh-')), ssh = await webSshFixture()
  const accounts = await Accounts.open({ directory, publicUrl: 'http://127.0.0.1:5173', production: false, mailer: null })
  const member = email => { const user = accounts.store.create(email, 'Dev', 'unused'); const verified = accounts.store.consumeToken(accounts.store.issueToken(user.id, 'verify', 10000), 'verify'); const session = accounts.store.issueSession(verified); return { user: verified, cookie: `outpost_session=${session.token}`, token: session.token } }
  const alice = member('alice-web@example.com'), bob = member('bob-web@example.com')
  const app = await createApp({ accounts, terminalGraceMs: 1000, service: { get: async (_target, id) => ({ id }) } })
  await app.listen({ host: '127.0.0.1', port: 0 }); const origin = `http://127.0.0.1:${app.server.address().port}`
  t.after(async () => { await app.close(); await ssh.close(); await rm(directory, { recursive: true, force: true }) })
  const request = (method, url, body, cookie = alice.cookie) => app.inject({ method, url, payload: body, headers: { cookie, 'x-outpost-request': '1' } })
  const target = (await request('POST', '/api/targets', { name: 'SSH', kind: 'ssh', host: '127.0.0.1', port: ssh.port, backends: ['tmux'], tools: ['codex'] })).json()
  const keyPath = `/api/targets/${target.id}/terminal-key`, launchPath = `/api/targets/${target.id}/sessions/test-session/web-terminal`
  assert.equal(ssh.commands.length, 0)
  assert.equal((await request('GET', keyPath)).json().key, null)
  assert.equal((await request('POST', launchPath, { cols: 80, rows: 24 })).statusCode, 409)
  for (const [method, path, body] of [['GET', keyPath], ['PUT', keyPath, { privateKey: ssh.key }], ['DELETE', keyPath], ['POST', launchPath, { cols: 80, rows: 24 }]]) assert.equal((await request(method, path, body, bob.cookie)).statusCode, 404)
  assert.equal((await request('PUT', keyPath, { privateKey: ssh.publicKey })).statusCode, 400)
  const saved = await request('PUT', keyPath, { privateKey: ssh.key }); assert.equal(saved.statusCode, 200, saved.body)
  assert.equal(saved.body.includes('PRIVATE KEY'), false); assert.equal(ssh.commands.length, 0, 'upload does not start SSH')
  assert.equal((await request('POST', launchPath, { cols: 5, rows: 24 })).statusCode, 400)
  const launched = await request('POST', launchPath, { cols: 80, rows: 24 }); assert.equal(launched.statusCode, 200, launched.body)
  const info = launched.json(), id = info.id
  assert.equal(ssh.commands.length, 1); assert.match(ssh.commands[0], /python3/)
  assert.equal((await request('POST', launchPath, { cols: 80, rows: 24 })).json().id, id, 'relaunch resumes held PTY')
  for (const [cookie, extra, expected] of [[bob.cookie, {}, 404], ['', {}, 401], [alice.cookie, { origin: 'https://evil.example' }, 403], [alice.cookie, { origin: '' }, 403]]) {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/api/web-terminals/${id}/socket`, { headers: { origin, cookie, ...extra } })
    const status = await new Promise(resolve => { ws.on('error', () => {}); ws.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); ws.terminate() }) })
    assert.equal(status, expected)
  }
  const first = await connect(origin, id, alice.cookie)
  assert.match(first.messages[0].data, /SSH fixture ready/)
  first.send({ type: 'input', data: 'hello-mobile\r' }); first.send({ type: 'resize', cols: 42, rows: 18 })
  await until(() => ssh.inputs.join('').includes('hello-mobile') && ssh.sizes.some(size => size[0] === 42 && size[1] === 18))
  const closed = once(first.ws, 'close'); first.ws.terminate(); await closed
  ssh.output('\r\nkept while offline\r\n'); await delay(50)
  const second = await connect(origin, id, alice.cookie)
  assert.match(second.messages[0].data, /kept while offline/); assert.equal(ssh.commands.length, 1, 'same remote PTY survives websocket disconnect')
  assert.equal((await request('DELETE', `/api/web-terminals/${id}`, undefined, bob.cookie)).statusCode, 404)
  const revoked = once(second.ws, 'close'); await request('POST', '/api/auth/logout'); await revoked
  assert.equal((await request('GET', keyPath)).statusCode, 401)
  // A fresh login can reuse the saved key, but cannot reuse the revoked login's PTY.
  const newCookie = `outpost_session=${accounts.store.issueSession(alice.user).token}`
  const next = await request('POST', launchPath, { cols: 80, rows: 24 }, newCookie); assert.equal(next.statusCode, 200, next.body)
  const third = await connect(origin, next.json().id, newCookie), removed = once(third.ws, 'close')
  assert.equal((await request('DELETE', keyPath, undefined, newCookie)).statusCode, 204); await removed
  assert.equal((await request('GET', keyPath, undefined, newCookie)).json().key, null)
  await request('PUT', keyPath, { privateKey: ssh.key }, newCookie)
  const expiring = (await request('POST', launchPath, { cols: 80, rows: 24 }, newCookie)).json()
  await delay(2100)
  assert.equal((await request('DELETE', `/api/web-terminals/${expiring.id}`, undefined, newCookie)).statusCode, 404, 'unattached terminals expire')
  await request('DELETE', `/api/targets/${target.id}`, undefined, newCookie)
  assert.equal((await new TerminalKeys(directory).status(alice.user.id, target.id)).key, null, 'target removal deletes uploaded key')
})

test('concurrent launches cannot bypass terminal limits and slow viewers apply SSH output backpressure', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-terminal-limits-')), ssh = await webSshFixture()
  const app = await createApp({ store: new TargetStore(directory), service: { get: async (_target, id) => ({ id }) } })
  await app.listen({ host: '127.0.0.1', port: 0 }); const origin = `http://127.0.0.1:${app.server.address().port}`
  t.after(async () => { await app.close(); await ssh.close(); await rm(directory, { recursive: true, force: true }) })
  const request = (method, url, payload) => app.inject({ method, url, payload, headers: { 'x-outpost-request': '1' } })
  const targets = []
  for (let i = 0; i < 5; i++) {
    const target = (await request('POST', '/api/targets', { name: `SSH ${i}`, kind: 'ssh', host: '127.0.0.1', port: ssh.port, backends: ['tmux'], tools: ['codex'] })).json()
    assert.equal((await request('PUT', `/api/targets/${target.id}/terminal-key`, { privateKey: ssh.key })).statusCode, 200)
    targets.push(target)
  }
  const started = await Promise.all(targets.map(target => request('POST', `/api/targets/${target.id}/sessions/test/web-terminal`, { cols: 80, rows: 24 })))
  assert.equal(started.filter(response => response.statusCode === 200).length, 4)
  assert.equal(started.filter(response => response.statusCode === 429).length, 1)
  const active = started.filter(response => response.statusCode === 200).map(response => response.json())
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/api/web-terminals/${active[0].id}/socket`, { headers: { origin } })
  ws.on('error', () => {})
  let snapshot = false, bytes = 0, acknowledge = false
  ws.on('message', (data, binary) => {
    if (binary) { bytes += data.length; if (acknowledge) ws.send(JSON.stringify({ type: 'ack', bytes: data.length })) }
    else {
      const message = JSON.parse(data)
      if (message.type === 'snapshot') { snapshot = true; ws.send(JSON.stringify({ type: 'ack', bytes: Buffer.byteLength(message.data) })) }
    }
  })
  await once(ws, 'open'); await until(() => snapshot)
  ssh.output('x'.repeat(512 * 1024))
  await until(() => bytes >= 128 * 1024); await delay(200)
  assert.ok(bytes < 512 * 1024, 'without browser acknowledgements the remote channel pauses')
  acknowledge = true; ws.send(JSON.stringify({ type: 'ack', bytes }))
  await until(() => bytes === 512 * 1024)
  const closed = once(ws, 'close'); ws.send(JSON.stringify({ type: 'resize', cols: -1, rows: 20 })); assert.equal((await closed)[0], 1008)
  for (const entry of active) assert.equal((await request('DELETE', `/api/web-terminals/${entry.id}`)).statusCode, 204)
  const again = await request('POST', `/api/targets/${targets[0].id}/sessions/test/web-terminal`, { cols: 80, rows: 24 })
  assert.equal(again.statusCode, 200, again.body)
  const viewer = await connect(origin, again.json().id, '')
  const shutDown = once(viewer.ws, 'close'); await app.close(); await shutDown
})
