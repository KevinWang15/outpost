import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Session, Target } from '../../shared/model'
import type { TerminalTicket } from '../../shared/protocol'
import { createApp } from '../../backend/app'
import { ConnectTokens } from '../../backend/terminal/tokens'
import { imageMediaTypes, maxImageBytes } from '../../shared/images'
import { LocalDeployment } from '../../backend/deployment'
import { TerminalClient } from '../integration/helpers'
import { FakeSessions, fakeSoftware } from './fakes'

async function setup(t: test.TestContext, env: NodeJS.ProcessEnv = process.env) {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-api-'))
  const sessions = new FakeSessions()
  const deployment = await LocalDeployment.open(directory)
  const app = await createApp({
    deployment,
    sessions,
    software: fakeSoftware,
    multiplex: false,
    env,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as { port: number }).port
  t.after(async () => {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  })
  const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.inject({
      method: method as 'GET',
      url: `/api${url}`,
      payload: payload as object,
      headers: { host: `127.0.0.1:${port}`, 'x-outpost-request': '1', ...headers },
    })
    return {
      status: response.statusCode,
      body: response.body ? JSON.parse(response.body) : undefined,
      headers: response.headers,
    }
  }
  return { app, port, sessions, call, deployment }
}

test('requests are limited to loopback, the configured host, same origin, and marked writes', async t => {
  const { app, port, call } = await setup(t)
  assert.equal(
    (await app.inject({ url: '/api/targets', remoteAddress: '10.0.0.5', headers: { host: `127.0.0.1:${port}` } }))
      .statusCode,
    403,
  )
  assert.equal((await call('GET', '/targets', undefined, { host: 'evil.example' })).status, 403)
  assert.equal((await call('GET', '/targets', undefined, { origin: 'https://evil.example' })).status, 403)
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/targets', headers: { host: `127.0.0.1:${port}` }, payload: {} }))
      .statusCode,
    403,
  )
  const listed = await call('GET', '/targets', undefined, { origin: `http://localhost:${port}` })
  assert.equal(listed.status, 200)
  assert.equal(listed.headers['cache-control'], 'no-store')
  assert.equal(listed.headers['x-frame-options'], 'DENY')
})

test('targets and sessions are validated strictly', async t => {
  const { call } = await setup(t)
  assert.equal(
    (await call('POST', '/targets', { kind: 'ssh', name: 'x', host: '-oProxyCommand=evil', tools: ['claude'] })).status,
    400,
  )
  assert.equal(
    (await call('POST', '/targets', { kind: 'ssh', name: 'x', host: 'dev', tools: ['claude'], unknown: true })).status,
    400,
  )
  assert.equal(
    (await call('POST', '/targets', { kind: 'local', name: 'x', host: 'dev', tools: ['claude'] })).status,
    400,
  )
  const { body: target } = (await call('POST', '/targets', {
    kind: 'ssh',
    name: ' dev ',
    host: 'dev.example.com',
    port: 2222,
    tools: ['claude', 'codex'],
  })) as { body: Target }
  assert.equal(target.name, 'dev')
  assert.equal((await call('PATCH', `/targets/${target.id}`, { tools: ['kimi'] })).body.tools[0], 'kimi')
  assert.equal((await call('PATCH', `/targets/${target.id}`, { host: 'other' })).status, 400)
  const base = `/targets/${target.id}/sessions`
  assert.equal(
    (await call('POST', base, { name: 'a', rootDir: '~/p', tool: 'claude' })).status,
    400,
    'tool not on target',
  )
  assert.equal((await call('POST', base, { name: 'a', rootDir: 'relative', tool: 'kimi' })).status, 400)
  assert.equal(
    (await call('POST', base, { name: 'a', rootDir: '~/p', tool: 'kimi', cliSessionId: 'not-a-kimi-id' })).status,
    400,
  )
  assert.equal(
    (await call('POST', base, { name: 'a', rootDir: '~/p', tool: 'kimi', env: { 'BAD NAME': 'x' } })).status,
    400,
  )
  assert.equal(
    (
      await call('POST', base, {
        name: 'a',
        rootDir: '~/p',
        tool: 'kimi',
        cliSessionId: 'session_abc',
        cliSessionEnv: { CODEX_HOME: '/x' },
      })
    ).status,
    400,
  )
  assert.equal(
    (await call('POST', base, { name: 'a', rootDir: '~/p', tool: 'kimi', env: { MODEL: 'k2' }, args: '--yolo' }))
      .status,
    201,
  )
  assert.equal((await call('GET', '/targets/missing/sessions')).status, 404)
})

test('web connections issue scoped tickets and reject terminal-choice payloads', async t => {
  const { call } = await setup(t)
  const { body: target } = (await call('POST', '/targets', {
    kind: 'ssh',
    name: 'dev',
    host: 'dev.example.com',
    tools: ['claude'],
  })) as { body: Target }
  const { body: session } = (await call('POST', `/targets/${target.id}/sessions`, {
    name: 'Build',
    rootDir: '~/p',
    tool: 'claude',
  })) as { body: Session }
  const path = `/targets/${target.id}/sessions/${session.id}/connect`
  assert.equal((await call('POST', path, { terminal: 'kitty' })).status, 400)
  const web = (await call('POST', path, {})).body as TerminalTicket
  assert.ok(web.token)
})

test('fork validates input, resolves the source on its target, and inherits launch settings', async t => {
  const { call } = await setup(t)
  const { body: target } = await call('POST', '/targets', { kind: 'local', name: 'Forks', tools: ['claude'] })
  const base = `/targets/${target.id}/sessions`
  const { body: source } = await call('POST', base, {
    name: 'Source',
    rootDir: '~/project',
    tool: 'claude',
    env: { MODEL: 'fixture' },
    args: '--model "$MODEL"',
  })
  const path = `${base}/${source.id}/fork`
  const input = { branch: 'feature/login', rootDir: '~/project-feature-login' }
  for (const invalid of [
    { ...input, branch: '' },
    { ...input, branch: 'bad\nbranch' },
    { ...input, rootDir: 'relative' },
    { ...input, tool: 'codex' },
    { ...input, cliSessionId: source.cliSessionId },
  ])
    assert.equal((await call('POST', path, invalid)).status, 400)
  const { body: other } = await call('POST', '/targets', { kind: 'local', name: 'Other', tools: ['claude'] })
  assert.equal((await call('POST', `/targets/${other.id}/sessions/${source.id}/fork`, input)).status, 404)
  const fork = await call('POST', path, input)
  assert.equal(fork.status, 201)
  assert.equal(fork.body.tool, source.tool)
  assert.deepEqual(fork.body.env, source.env)
  assert.equal(fork.body.args, source.args)
  assert.notEqual(fork.body.cliSessionId, source.cliSessionId)
  await call('PATCH', `/targets/${target.id}`, { tools: ['codex'] })
  assert.equal((await call('POST', path, input)).status, 400)
})

test('the broker relays a terminal and reports attach failures', async t => {
  const { port, call, sessions } = await setup(t)
  const { body: target } = (await call('POST', '/targets', {
    kind: 'ssh',
    name: 'dev',
    host: 'dev.example.com',
    tools: ['claude'],
  })) as { body: Target }
  const { body: session } = (await call('POST', `/targets/${target.id}/sessions`, {
    name: 'Build',
    rootDir: '~/p',
    tool: 'claude',
  })) as { body: Session }
  const connect = async () =>
    (await call('POST', `/targets/${target.id}/sessions/${session.id}/connect`, {})).body as TerminalTicket
  const { token } = await connect()
  const client = new TerminalClient(
    `ws://127.0.0.1:${port}/api/terminal?token=${encodeURIComponent(token)}&cols=120&rows=40`,
  )
  t.after(() => client.socket.terminate())
  const hello = await client.message('hello')
  assert.equal(hello.session.name, 'Build')
  await client.message('ready')
  await client.text('started 120x40')
  assert.ok(!client.output.includes('Welcome to the target'), 'login noise before the relay is not shown')
  assert.deepEqual(sessions.attached.at(-1), { targetId: target.id, id: session.id, cols: 120, rows: 40 })
  client.input('hello')
  await client.text('echo:hello')
  client.send({ type: 'resize', cols: 100, rows: 30 })
  await client.text('size:100x30')
  const upload = await fetch(`http://127.0.0.1:${port}/api/terminal/image`, {
    method: 'POST',
    headers: { authorization: `Bearer ${hello.resume}`, 'x-outpost-request': '1', 'content-type': 'image/webp' },
    body: Buffer.from('UklGRgAAAABXRUJQ', 'base64'),
  })
  assert.equal(upload.status, 200)
  const image = (await upload.json()) as { reference: string }
  client.send({ type: 'paste', id: 'p', data: image.reference })
  assert.deepEqual(await client.take('result'), { type: 'result', id: 'p', ok: true })
  client.input('signal:https://example.com/')
  assert.deepEqual((await client.take('signal')).signal, {
    type: 'browser.open',
    payload: { url: 'https://example.com/' },
  })
  await client.text('signal-result:true')
  client.input('signal:javascript:alert(1)')
  await client.text('signal-result:false')
  assert.equal(
    client.messages.filter(message => message.type === 'signal').length,
    0,
    'invalid links never reach the client',
  )
  client.input('exit')
  assert.deepEqual(await client.message('closed'), {
    type: 'closed',
    reason: 'ended',
    message: 'The coding tool exited. Connect again to start it in the same conversation.',
  })

  const failing = await setup(t, { ...process.env, FAKE_RELAY: 'fail' })
  const { body: other } = (await failing.call('POST', '/targets', {
    kind: 'ssh',
    name: 'dev',
    host: 'dev',
    tools: ['claude'],
  })) as { body: Target }
  const { body: otherSession } = (await failing.call('POST', `/targets/${other.id}/sessions`, {
    name: 'x',
    rootDir: '~/p',
    tool: 'claude',
  })) as { body: Session }
  const failed = (await failing.call('POST', `/targets/${other.id}/sessions/${otherSession.id}/connect`, {}))
    .body as TerminalTicket
  const broken = new TerminalClient(
    `ws://127.0.0.1:${failing.port}/api/terminal?token=${encodeURIComponent(failed.token)}`,
  )
  t.after(() => broken.socket.terminate())
  assert.deepEqual(await broken.message('closed'), { type: 'closed', reason: 'ended', message: 'Session not found' })
})

test('clients speaking another protocol version are told to update, without spending the launch token', async t => {
  const { port, call } = await setup(t)
  const { body: target } = (await call('POST', '/targets', {
    kind: 'ssh',
    name: 'dev',
    host: 'dev.example.com',
    tools: ['claude'],
  })) as { body: Target }
  const { body: session } = (await call('POST', `/targets/${target.id}/sessions`, {
    name: 'Build',
    rootDir: '~/p',
    tool: 'claude',
  })) as { body: Session }
  const { token } = (await call('POST', `/targets/${target.id}/sessions/${session.id}/connect`, {}))
    .body as TerminalTicket
  const base = `ws://127.0.0.1:${port}/api/terminal?token=${encodeURIComponent(token)}`
  const page = new TerminalClient(`${base}&protocol=`)
  t.after(() => page.socket.terminate())
  assert.equal((await page.message('closed')).message, 'Outpost was updated. Reload this terminal to reconnect.')
  const current = new TerminalClient(base)
  t.after(() => current.socket.terminate())
  await current.message('ready')
})

test('the production server serves the terminal page on direct navigation and refresh', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-terminal-page-'))
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>Outpost</title>')
  const app = await createApp({
    deployment: await LocalDeployment.open(join(directory, 'data')),
    frontendRoot: directory,
  })
  t.after(async () => {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as { port: number }).port
  for (const method of ['GET', 'HEAD'] as const) {
    for (const url of ['/terminal?target=box&session=session', '/terminal/desktop', '/desktop']) {
      const response = await app.inject({
        method,
        url,
        headers: { host: `127.0.0.1:${port}` },
      })
      assert.equal(response.statusCode, 200)
      assert.match(response.headers['content-type']!, /text\/html/)
      if (method === 'GET') assert.match(response.body, /<title>Outpost<\/title>/)
    }
  }
})

test('image upload authorization and binary parsing are scoped, bounded, and preserve every byte', async t => {
  const { app, call, port, sessions, deployment } = await setup(t)
  const target = (await call('POST', '/targets', { kind: 'local', name: 'Images', tools: ['claude'] })).body as Target
  const session = (
    await call('POST', `/targets/${target.id}/sessions`, { name: 'Image session', rootDir: '~/p', tool: 'claude' })
  ).body as Session
  const tokens = new ConnectTokens(deployment.secret)
  const grant = { owner: { userId: 'local', loginId: 'local' }, targetId: target.id, sessionId: session.id }
  const launch = tokens.issue(grant)
  const resume = tokens.resume(launch.id, grant)
  const data = Buffer.from([0, 255, 13, 10, 32, 137, 80, 78, 71, 0, 32, 10])
  const uploaded = t.mock.method(sessions, 'uploadImage', async (context, id, bytes, mediaType, signal) => {
    assert.equal(context.target.id, target.id)
    assert.equal(id, session.id)
    assert.ok(Buffer.isBuffer(bytes))
    assert.ok(imageMediaTypes.includes(mediaType))
    assert.equal(signal.aborted, false)
    return { path: '/image.png', reference: '/image.png' }
  })
  const upload = (token: string, payload = data, type = 'image/png') =>
    app.inject({
      method: 'POST',
      url: '/api/terminal/image',
      payload,
      headers: {
        host: `127.0.0.1:${port}`,
        'x-outpost-request': '1',
        authorization: `Bearer ${token}`,
        'content-type': type,
      },
    })
  for (const token of ['', 'invalid', launch.token, resume + 'tampered'])
    assert.equal((await upload(token)).statusCode, 401)
  assert.equal(uploaded.mock.callCount(), 0)
  assert.ok(tokens.redeem(launch.token), 'an upload must not spend a launch ticket')
  for (const type of imageMediaTypes) {
    assert.equal((await upload(resume, data, type)).statusCode, 200)
    assert.deepEqual(uploaded.mock.calls.at(-1)!.arguments[2], data)
  }
  assert.equal((await upload(resume, Buffer.alloc(maxImageBytes))).statusCode, 200)
  assert.equal(uploaded.mock.calls.at(-1)!.arguments[2].length, maxImageBytes)
  const count = uploaded.mock.callCount()
  assert.equal((await upload(resume, Buffer.alloc(maxImageBytes + 1))).statusCode, 413)
  assert.equal((await upload(resume, data, 'image/svg+xml')).statusCode, 415)
  assert.equal((await upload(resume, Buffer.from('{}'), 'application/json')).statusCode, 415)
  assert.equal(uploaded.mock.callCount(), count)
  const other = tokens.resume('other', { ...grant, targetId: 'missing' })
  assert.equal((await upload(other)).statusCode, 404)
  assert.equal(uploaded.mock.callCount(), count)
  assert.equal((await call('POST', `/targets/${target.id}/sessions/${session.id}/image`, {})).status, 404)
  assert.equal(
    (await call('GET', `/targets/${target.id}/sessions`)).status,
    200,
    'binary parser is isolated from normal routes',
  )
})

test('closing an image HTTP request aborts its target upload operation', async t => {
  const { sessions, deployment, call, port } = await setup(t)
  const target = (await call('POST', '/targets', { kind: 'local', name: 'Abort', tools: ['claude'] })).body as Target
  const tokens = new ConnectTokens(deployment.secret)
  const token = tokens.resume('upload', {
    owner: { userId: 'local', loginId: 'local' },
    targetId: target.id,
    sessionId: 'session',
  })
  const started = Promise.withResolvers<AbortSignal>()
  const stopped = Promise.withResolvers<void>()
  t.mock.method(sessions, 'uploadImage', async (_context, _id, _bytes, _type, signal) => {
    started.resolve(signal)
    return new Promise((_resolve, reject) =>
      signal.addEventListener(
        'abort',
        () => {
          stopped.resolve()
          reject(new Error('Upload cancelled'))
        },
        { once: true },
      ),
    )
  })
  const controller = new AbortController()
  t.after(() => controller.abort())
  const request = fetch(`http://127.0.0.1:${port}/api/terminal/image`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-outpost-request': '1', 'content-type': 'image/png' },
    body: Buffer.from([137, 80, 78, 71]),
    signal: controller.signal,
  })
  const rejected = assert.rejects(request, /abort/i)
  const signal = await started.promise
  controller.abort()
  await rejected
  await stopped.promise
  assert.equal(signal.aborted, true)
})
