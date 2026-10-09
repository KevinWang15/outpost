import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { Signals } from '../backend/signals.ts'
import { SignalChannels } from '../backend/signal-channels.ts'
import { browserUrl } from '../shared/signals.ts'
import { AccountSshKeys, AccountTargetStore } from '../backend/account-ssh.ts'
import { webSshFixture } from './fixtures/web-ssh.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runCommand } from '../backend/process.ts'

const execute = promisify(execFile)

test('real target HTTP, curl exit status, BROWSER and generic helpers use scoped tokens over the local transport', { skip: process.platform === 'win32', timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "outpost signals 'quoted' é "))
  const signals = new Signals(() => true), received = []
  const channels = new SignalChannels((token, body) => signals.dispatch(token, body))
  t.after(async () => { channels.close(); signals.close(); await rm(directory, { recursive: true, force: true }) })
  signals.define('browser.open', browserUrl)
  const owner = { userId: 'local', authSessionId: 'local' }
  const token = signals.issue(owner, 'target', 'session')
  const target = { id: 'target', kind: 'local', environment: { home: directory, uid: process.getuid(), username: 'fixture', shell: '/bin/bash' } }
  const environment = await channels.prepare(target, 'session', { scope: 'a'.repeat(32), token })
  const config = JSON.parse(await readFile(environment.OUTPOST_SIGNAL_CONFIG, 'utf8'))
  assert.equal(config.token, token)
  assert.equal((await stat(environment.OUTPOST_SIGNAL_CONFIG)).mode & 0o777, 0o600)
  assert.equal(environment.BROWSER, 'outpost-browser', 'a plain executable supports BROWSER implementations without shell quoting')
  const capture = join(directory, 'capture-environment')
  await writeFile(capture, '#!/usr/bin/env python3\nimport json,os\nprint(json.dumps({key: os.environ.get(key) for key in ("BROWSER", "PATH", "OUTPOST_SESSION_TOKEN")}))\n', { mode: 0o700 })
  const session = { tool: 'codex', cliSessionId: randomUUID(), cliSessionEnv: {}, rootDir: directory, env: { PATH: process.env.PATH }, args: '' }
  const launched = await runCommand({ executable: 'python3', args: [fileURLToPath(new URL('./fixtures/session-launch.py', import.meta.url))], label: 'Launch fixture' }, JSON.stringify([
    { session, executable: capture, signals: environment.OUTPOST_SIGNAL_ENV },
    { session: { ...session, env: { ...session.env, BROWSER: 'custom-browser' } }, executable: capture, signals: environment.OUTPOST_SIGNAL_ENV },
  ]))
  assert.equal(launched.code, 0, launched.stderr)
  const launchResults = JSON.parse(launched.stdout)
  for (const result of launchResults) assert.equal(result.code, 0, result.stderr)
  const launchedEnvironment = JSON.parse(launchResults[0].stdout)
  assert.equal(launchedEnvironment.BROWSER, 'outpost-browser')
  assert.equal(launchedEnvironment.OUTPOST_SESSION_TOKEN, token)
  assert.ok(launchedEnvironment.PATH.startsWith(environment.OUTPOST_SIGNAL_BIN + ':'))
  assert.equal(JSON.parse(launchResults[1].stdout).BROWSER, 'custom-browser')
  const signal = { version: 1, id: randomUUID(), type: 'browser.open', payload: { url: 'https://example.com/?fileName=hello&literal=%24%28test%29' } }
  const curl = body => execute('curl', ['--fail', '--silent', '--show-error', '--noproxy', '*', '--max-time', '5', '-H', `Authorization: Bearer ${token}`, '-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(body), config.url])
  await assert.rejects(curl(signal), { code: 22 }, 'no listener returns HTTP failure and curl exits nonzero')
  signals.registerLocal('browser.open', event => { received.push(event) })
  assert.deepEqual(JSON.parse((await curl(signal)).stdout), { id: signal.id })
  await curl(signal)
  assert.equal(received.length, 1)
  const env = { ...process.env, PATH: `${environment.OUTPOST_SIGNAL_BIN}:${process.env.PATH}` }
  await execute(environment.BROWSER, [signal.payload.url], { env })
  assert.equal(received.length, 2)
  assert.deepEqual(received[1].payload, signal.payload, 'URL punctuation remains literal data')
  await assert.rejects(execute('outpost-signal', ['work.progress', '{"done":1}'], { env }), { code: 1 })
  signals.registerLocal('work.progress', event => received.push(event))
  await execute('outpost-signal', ['work.progress', '{"done":1}'], { env })
  assert.deepEqual(received.at(-1).payload, { done: 1 })
  const invalid = await fetch(config.url, { method: 'POST', headers: { authorization: 'Bearer invalid' }, body: JSON.stringify(signal) })
  assert.equal(invalid.status, 401)
  const oversized = await fetch(config.url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: 'x'.repeat(33000) })
  assert.equal(oversized.status, 413)
  for (const payload of ['NaN', 'Infinity', '-Infinity', '1e999', '['.repeat(10000) + '0' + ']'.repeat(10000)]) {
    const response = await fetch(config.url, { method: 'POST', headers: { authorization: `Bearer ${token}` },
      body: `{"version":1,"id":"invalid-json","type":"work.progress","payload":${payload}}`, signal: AbortSignal.timeout(3000) })
    assert.equal(response.status, 400, `invalid JSON (${payload.slice(0, 20)}) must not tear down the shared relay`)
  }
  assert.equal(JSON.parse(await readFile(environment.OUTPOST_SIGNAL_CONFIG, 'utf8')).url, config.url)
  await curl(signal)
  assert.equal(received.length, 3, 'the same receiver still accepts requests after invalid input')
  signals.revoke(owner.userId, 'target', 'session')
  await assert.rejects(execute(environment.BROWSER, [signal.payload.url], { env }), { code: 1 })
  // A fresh grant updates the existing helper without restarting its caller.
  const next = signals.issue(owner, 'target', 'session')
  const refreshed = await channels.prepare(target, 'session', { scope: 'a'.repeat(32), token: next })
  assert.equal(refreshed.OUTPOST_SIGNAL_CONFIG, environment.OUTPOST_SIGNAL_CONFIG)
  await execute(environment.BROWSER, [signal.payload.url], { env })
  assert.equal(received.length, 4)
  channels.close()
  await assert.rejects(channels.prepare(target, 'session', { scope: 'a'.repeat(32), token: next }), { statusCode: 503 })
})

test('SSH signals recover from setup timeouts and connection drops using the account identity', { skip: process.platform === 'win32', timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-ssh-signals-'))
  const workers = new Set()
  let stall = true
  const ssh = await webSshFixture((command, channel) => {
    if (stall) {
      stall = false
      channel.resume()
      channel.write('OUTPOST_SIGNAL:{"kind":"ready"}\n')
      return // Simulate a receiver that starts but never acknowledges setup.
    }
    const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
    workers.add(child)
    child.stdin.on('error', () => {})
    channel.pipe(child.stdin); child.stdout.pipe(channel); child.stderr.pipe(channel.stderr)
    channel.on('close', () => child.kill())
    child.on('close', code => { workers.delete(child); channel.exit(code ?? 1); channel.end() })
  })
  const keys = new AccountSshKeys(directory), userId = randomUUID()
  ssh.authorize((await keys.publicKey(userId)).publicKey)
  const targets = new AccountTargetStore(directory, userId, keys)
  await targets.add({ id: 'ssh', name: 'Signal SSH', kind: 'ssh', host: '127.0.0.1', port: ssh.port, backends: ['tmux'], tools: ['codex'], createdAt: new Date().toISOString(),
    environment: { home: directory, uid: process.getuid(), username: 'root', shell: '/bin/bash', platform: 'linux' } })
  const target = await targets.get('ssh'), owner = { userId, authSessionId: randomUUID() }
  const signals = new Signals(() => true), received = []
  const channels = new SignalChannels((token, body) => signals.dispatch(token, body), process.env, true)
  t.after(async () => { channels.close(); signals.close(); await ssh.close(); for (const child of workers) child.kill(); await rm(directory, { recursive: true, force: true }) })
  signals.listen('browser', owner, ['test.echo'], event => received.push(event), () => {})
  const environments = []
  const setup = { scope: 'b'.repeat(32), token: signals.issue(owner, target.id, 'one') }
  await assert.rejects(channels.prepare(target, 'one', setup), { statusCode: 504 })
  for (let attempt = 0; attempt < 50 && ssh.commands.length < 2; attempt++) await delay(100)
  assert.equal(ssh.commands.length, 2, 'a stalled receiver is replaced so future attachments can recover')
  for (const id of ['one', 'two']) environments.push(await channels.prepare(target, id, { scope: 'b'.repeat(32), token: signals.issue(owner, target.id, id) }))
  assert.equal(ssh.commands.length, 2, 'sessions share one authenticated transport')
  const send = environment => execute(join(environment.OUTPOST_SIGNAL_BIN, 'outpost-signal'), ['test.echo', '{"hello":"SSH"}'])
  await send(environments[0])
  assert.equal(received[0].sessionId, 'one')
  const old = JSON.parse(await readFile(environments[1].OUTPOST_SIGNAL_CONFIG, 'utf8')).url
  ssh.disconnect()
  for (let attempt = 0; attempt < 100; attempt++) {
    if (JSON.parse(await readFile(environments[1].OUTPOST_SIGNAL_CONFIG, 'utf8')).url !== old) break
    await delay(100)
  }
  assert.notEqual(JSON.parse(await readFile(environments[1].OUTPOST_SIGNAL_CONFIG, 'utf8')).url, old)
  await send(environments[0]); await send(environments[1])
  assert.deepEqual(received.map(event => event.sessionId), ['one', 'one', 'two'])
  assert.equal(ssh.commands.length, 3)
})
