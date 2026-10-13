import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Session, Target } from '../../shared/model'
import type { ConnectResponse } from '../../shared/protocol'
import { createApp } from '../../backend/app'
import { LocalDeployment } from '../../backend/deployment'
import { TerminalClient } from '../integration/helpers'
import { FakeSessions, fakeSoftware } from './fakes'

async function setup(t: test.TestContext, env: NodeJS.ProcessEnv = process.env) {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-api-'))
  const sessions = new FakeSessions()
  const app = await createApp({ deployment: await LocalDeployment.open(directory), sessions, software: fakeSoftware, multiplex: false, env })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as { port: number }).port
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }) })
  const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.inject({ method: method as 'GET', url: `/api${url}`, payload: payload as object, headers: { host: `127.0.0.1:${port}`, 'x-outpost-request': '1', ...headers } })
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined, headers: response.headers }
  }
  return { app, port, sessions, call }
}

test('requests are limited to loopback, the configured host, same origin, and marked writes', async t => {
  const { app, port, call } = await setup(t)
  assert.equal((await app.inject({ url: '/api/targets', remoteAddress: '10.0.0.5', headers: { host: `127.0.0.1:${port}` } })).statusCode, 403)
  assert.equal((await call('GET', '/targets', undefined, { host: 'evil.example' })).status, 403)
  assert.equal((await call('GET', '/targets', undefined, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await app.inject({ method: 'POST', url: '/api/targets', headers: { host: `127.0.0.1:${port}` }, payload: {} })).statusCode, 403)
  const listed = await call('GET', '/targets', undefined, { origin: `http://localhost:${port}` })
  assert.equal(listed.status, 200)
  assert.equal(listed.headers['cache-control'], 'no-store')
  assert.equal(listed.headers['x-frame-options'], 'DENY')
})

test('targets and sessions are validated strictly', async t => {
  const { call } = await setup(t)
  assert.equal((await call('POST', '/targets', { kind: 'ssh', name: 'x', host: '-oProxyCommand=evil', tools: ['claude'] })).status, 400)
  assert.equal((await call('POST', '/targets', { kind: 'ssh', name: 'x', host: 'dev', tools: ['claude'], backends: ['dtach'] })).status, 400)
  assert.equal((await call('POST', '/targets', { kind: 'local', name: 'x', host: 'dev', tools: ['claude'] })).status, 400)
  const { body: target } = await call('POST', '/targets', { kind: 'ssh', name: ' dev ', host: 'dev.example.com', port: 2222, tools: ['claude', 'codex'] }) as { body: Target }
  assert.equal(target.name, 'dev')
  assert.equal((await call('PATCH', `/targets/${target.id}`, { tools: ['kimi'] })).body.tools[0], 'kimi')
  assert.equal((await call('PATCH', `/targets/${target.id}`, { host: 'other' })).status, 400)
  const base = `/targets/${target.id}/sessions`
  assert.equal((await call('POST', base, { name: 'a', rootDir: '~/p', tool: 'claude' })).status, 400, 'tool not on target')
  assert.equal((await call('POST', base, { name: 'a', rootDir: 'relative', tool: 'kimi' })).status, 400)
  assert.equal((await call('POST', base, { name: 'a', rootDir: '~/p', tool: 'kimi', cliSessionId: 'not-a-kimi-id' })).status, 400)
  assert.equal((await call('POST', base, { name: 'a', rootDir: '~/p', tool: 'kimi', env: { 'BAD NAME': 'x' } })).status, 400)
  assert.equal((await call('POST', base, { name: 'a', rootDir: '~/p', tool: 'kimi', cliSessionId: 'session_abc', cliSessionEnv: { CODEX_HOME: '/x' } })).status, 400)
  assert.equal((await call('POST', base, { name: 'a', rootDir: '~/p', tool: 'kimi', env: { MODEL: 'k2' }, args: '--yolo' })).status, 201)
  assert.equal((await call('GET', '/targets/missing/sessions')).status, 404)
})

test('connect returns a web token or an outpost:// link for the chosen terminal', async t => {
  const { port, call } = await setup(t)
  const { body: target } = await call('POST', '/targets', { kind: 'ssh', name: 'dev', host: 'dev.example.com', tools: ['claude'] }) as { body: Target }
  const { body: session } = await call('POST', `/targets/${target.id}/sessions`, { name: 'Build', rootDir: '~/p', tool: 'claude' }) as { body: Session }
  const path = `/targets/${target.id}/sessions/${session.id}/connect`
  assert.equal((await call('POST', path, { terminal: 'kitty' })).status, 400)
  const web = (await call('POST', path, { terminal: 'web' })).body as ConnectResponse
  assert.equal(web.url, null)
  const native = (await call('POST', path, { terminal: 'windows-terminal' })).body as ConnectResponse
  const link = JSON.parse(Buffer.from(native.url!.slice('outpost://connect/'.length), 'base64url').toString())
  assert.deepEqual(link, { v: 1, server: `http://127.0.0.1:${port}`, token: native.token, terminal: 'windows-terminal', title: 'Build · dev' })
  assert.deepEqual((await call('GET', `/connections/${native.id}`)).body, { status: 'pending' })
})

test('the broker relays a terminal and reports attach failures', async t => {
  const { port, call, sessions } = await setup(t)
  const { body: target } = await call('POST', '/targets', { kind: 'ssh', name: 'dev', host: 'dev.example.com', tools: ['claude'] }) as { body: Target }
  const { body: session } = await call('POST', `/targets/${target.id}/sessions`, { name: 'Build', rootDir: '~/p', tool: 'claude' }) as { body: Session }
  const connect = async (terminal = 'iterm2') => (await call('POST', `/targets/${target.id}/sessions/${session.id}/connect`, { terminal })).body as ConnectResponse
  const { token, id } = await connect()
  const client = new TerminalClient(`ws://127.0.0.1:${port}/api/terminal?token=${encodeURIComponent(token)}&cols=120&rows=40`)
  t.after(() => client.socket.terminate())
  assert.equal((await client.message('hello')).session.name, 'Build')
  await client.message('ready')
  await client.text('started 120x40')
  assert.ok(!client.output.includes('Welcome to the target'), 'login noise before the relay is not shown')
  assert.deepEqual(sessions.attached.at(-1), { targetId: target.id, id: session.id, cols: 120, rows: 40 })
  assert.deepEqual((await call('GET', `/connections/${id}`)).body, { status: 'connected' })
  client.input('hello')
  await client.text('echo:hello')
  client.send({ type: 'resize', cols: 100, rows: 30 })
  await client.text('size:100x30')
  client.send({ type: 'paste-image', id: 'p', mediaType: 'image/webp', data: 'UklGRgAAAABXRUJQ' })
  assert.deepEqual(await client.take('result'), { type: 'result', id: 'p', ok: true, reference: '/root/.outpost/clipboard/x.webp' })
  client.input('signal:https://example.com/')
  assert.deepEqual((await client.take('signal')).signal, { type: 'browser.open', payload: { url: 'https://example.com/' } })
  await client.text('signal-result:true')
  client.input('signal:javascript:alert(1)')
  await client.text('signal-result:false')
  assert.equal(client.messages.filter(message => message.type === 'signal').length, 0, 'invalid links never reach the client')
  client.input('detach')
  assert.deepEqual(await client.message('closed'), { type: 'closed', reason: 'detached', message: 'Detached. The session keeps running.' })

  const failing = await setup(t, { ...process.env, FAKE_RELAY: 'fail' })
  const { body: other } = await failing.call('POST', '/targets', { kind: 'ssh', name: 'dev', host: 'dev', tools: ['claude'] }) as { body: Target }
  const { body: otherSession } = await failing.call('POST', `/targets/${other.id}/sessions`, { name: 'x', rootDir: '~/p', tool: 'claude' }) as { body: Session }
  const failed = (await failing.call('POST', `/targets/${other.id}/sessions/${otherSession.id}/connect`, { terminal: 'web' })).body as ConnectResponse
  const broken = new TerminalClient(`ws://127.0.0.1:${failing.port}/api/terminal?token=${encodeURIComponent(failed.token)}`)
  t.after(() => broken.socket.terminate())
  assert.deepEqual(await broken.message('closed'), { type: 'closed', reason: 'error', message: 'Session not found' })
})

test('the connector is served with an installer for this server', async t => {
  const { app, port } = await setup(t)
  const script = await app.inject({ url: '/connector/install.sh', headers: { host: `127.0.0.1:${port}` } })
  assert.match(script.body, new RegExp(`server='http://127.0.0.1:${port}'`))
  const archive = await app.inject({ url: '/connector/outpost-connector.pyz', headers: { host: `127.0.0.1:${port}` } })
  assert.equal(archive.rawPayload.subarray(0, 2).toString(), 'PK')
})
