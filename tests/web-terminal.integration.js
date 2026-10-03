import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { createApp } from '../backend/app.ts'
import { Accounts } from '../backend/accounts.ts'

const execute = promisify(execFile)
const docker = async (...args) => (await execute('docker', args, { timeout: 120000, maxBuffer: 4000000 })).stdout.trim()
async function until(predicate) { for (let i = 0; i < 100; i++) { if (await predicate()) return; await delay(100) }; assert.fail('condition timed out') }
async function connect(origin, id, cookie) {
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/api/web-terminals/${id}/socket`, { headers: { origin, cookie } })
  let screen = ''
  ws.on('error', () => {})
  ws.on('message', (data, binary) => {
    if (binary) { screen += data.toString(); ws.send(JSON.stringify({ type: 'ack', bytes: data.length })) }
    else {
      const message = JSON.parse(data)
      if (message.type === 'snapshot') { screen += message.data; ws.send(JSON.stringify({ type: 'ack', bytes: Buffer.byteLength(message.data) })) }
    }
  })
  await once(ws, 'open')
  await until(() => screen.includes('OUTPOST_FIXTURE_READY'))
  return { ws, screen: () => screen, send: message => ws.send(JSON.stringify(message)) }
}

test('OpenSSH web PTY with tmux and dtach preserves CLI identity, input, resize, repaint and process across web disconnects', { timeout: 240000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-web-terminal-integration-'))
  let container, app, accounts
  t.after(async () => { if (app) await app.close(); else accounts?.close(); if (container) await docker('rm', '-f', container); await rm(directory, { recursive: true, force: true }) })
  await docker('build', '-t', 'outpost-ssh-test:local', fileURLToPath(new URL('./fixtures/', import.meta.url)))
  const keyPath = join(directory, 'synthetic-key')
  await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'test-passphrase', '-f', keyPath])
  // Management needs an unencrypted identity, while web mode accepts the encrypted upload.
  accounts = await Accounts.open({ directory: join(directory, 'state'), publicUrl: 'http://127.0.0.1:5173', production: false, mailer: null })
  const user = accounts.store.create('ssh-web@example.com', 'SSH Dev', 'unused')
  const verified = accounts.store.consumeToken(accounts.store.issueToken(user.id, 'verify', 10000), 'verify')
  const cookie = `outpost_session=${accounts.store.issueSession(verified).token}`
  await accounts.keys.publicKey(user.id)
  const managerKey = accounts.keys.paths(user.id).identityFile
  container = await docker('run', '-d', '--rm', '-p', '127.0.0.1::22', 'outpost-ssh-test:local')
  await docker('cp', `${keyPath}.pub`, `${container}:/root/.ssh/authorized_keys`)
  await docker('cp', `${managerKey}.pub`, `${container}:/tmp/manager.pub`)
  await docker('exec', container, 'sh', '-c', 'cat /tmp/manager.pub >> /root/.ssh/authorized_keys; chown 0:0 /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys; apt-get update -qq && apt-get install -y -qq tmux dtach')
  const port = Number((await docker('port', container, '22')).split(':').at(-1))
  app = await createApp({ accounts })
  await app.listen({ host: '127.0.0.1', port: 0 }); const origin = `http://127.0.0.1:${app.server.address().port}`
  const request = async (method, path, body) => {
    const response = await app.inject({ method, url: `/api${path}`, payload: body, headers: { cookie, 'x-outpost-request': '1' } })
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body)
    return response.statusCode === 204 ? null : response.json()
  }
  const target = await request('POST', '/targets', { name: 'Real SSH', kind: 'ssh', host: '127.0.0.1', port, identityFile: managerKey, backends: ['tmux', 'dtach'], tools: ['codex'] })
  const base = `/targets/${target.id}`
  await request('GET', `${base}/software`)
  await request('PUT', `${base}/terminal-key`, { privateKey: await readFile(keyPath, 'utf8'), passphrase: 'test-passphrase' })
  for (const backend of ['tmux', 'dtach']) await t.test(backend, async () => {
    const rootDir = `/root/web-${backend}`
    await docker('exec', container, 'mkdir', '-p', rootDir)
    const session = await request('POST', `${base}/sessions`, { name: `Web ${backend}`, rootDir, backend, tool: 'codex' })
    await docker('exec', container, 'touch', `${rootDir}/capture-input`)
    const start = () => request('POST', `${base}/sessions/${session.id}/web-terminal`, { cols: 80, rows: 24 })
    const info = await start(), first = await connect(origin, info.id, cookie)
    assert.match((await request('GET', `${base}/terminal-key`)).key.hostFingerprint, /^SHA256:/)
    const heartbeat = () => docker('exec', container, 'cat', `${rootDir}/heartbeat.json`).then(JSON.parse)
    const initial = await heartbeat()
    first.send({ type: 'input', data: 'WEB_MOBILE_INPUT\r' })
    first.send({ type: 'resize', cols: 42, rows: 18 })
    await until(async () => (await docker('exec', container, 'cat', `${rootDir}/sizes.log`)).includes('42x18'))
    await until(async () => (await docker('exec', container, 'cat', `${rootDir}/input.bin`)).includes('WEB_MOBILE_INPUT'))
    const closed = once(first.ws, 'close'); first.ws.terminate(); await closed
    await delay(300)
    assert.equal((await start()).id, info.id)
    const second = await connect(origin, info.id, cookie)
    assert.equal((await heartbeat()).pid, initial.pid, 'a network drop keeps the backend PTY and coding process')
    assert.match(second.screen(), /OUTPOST_FIXTURE_READY/)
    const secondClosed = once(second.ws, 'close'); await request('DELETE', `/web-terminals/${info.id}`); await secondClosed
    assert.equal((await request('GET', `${base}/sessions/${session.id}`)).status, 'detached')
    const again = await start(), third = await connect(origin, again.id, cookie)
    assert.notEqual(again.id, info.id)
    assert.equal((await heartbeat()).pid, initial.pid, 'explicit web detach also preserves the remote process')
    assert.equal((await docker('exec', container, 'cat', `${rootDir}/starts.log`)).split('\n').length, 1)
    const thirdClosed = once(third.ws, 'close'); await request('POST', `${base}/sessions/${session.id}/terminate`); await thirdClosed
    assert.equal((await request('GET', `${base}/sessions/${session.id}`)).status, 'stopped')
  })
})
