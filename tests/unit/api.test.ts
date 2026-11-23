import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Session, Target } from '../../shared/model'
import type { TerminalTicket } from '../../shared/protocol'
import { createApp } from '../../backend/app'
import { LocalDeployment } from '../../backend/deployment'
import { TerminalClient } from '../integration/helpers'
import { FakeSessions, fakeSoftware } from './fakes'

async function setup(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-api-'))
  const sessions = new FakeSessions()
  const deployment = await LocalDeployment.open(directory)
  const app = await createApp({ history: false, deployment, sessions, software: fakeSoftware, multiplex: false })
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
  /** An SSH target with one session on it. */
  const addSession = async () => {
    const { body: target } = (await call('POST', '/targets', {
      kind: 'ssh',
      name: 'dev',
      host: 'dev.example.com',
      user: 'dev',
    })) as { body: Target }
    const { body: session } = (await call('POST', `/targets/${target.id}/sessions`, {
      name: 'Build',
      rootDir: '~/p',
      tool: 'claude',
    })) as { body: Session }
    return { target, session }
  }
  return { app, port, sessions, call, addSession, deployment }
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
  // SSH targets name the Linux user sessions run as; it is required and cannot look like an option.
  for (const user of [undefined, '', '-oProxyCommand=evil', 'a b', 'x'.repeat(33)])
    assert.equal(
      (
        await call('POST', '/targets', {
          kind: 'ssh',
          name: 'x',
          host: 'dev',
          ...(user === undefined ? {} : { user }),
        })
      ).status,
      400,
      String(user),
    )
  assert.equal(
    (
      await call('POST', '/targets', {
        kind: 'ssh',
        name: 'x',
        host: '-oProxyCommand=evil',
        user: 'dev',
      })
    ).status,
    400,
  )
  assert.equal(
    (
      await call('POST', '/targets', {
        kind: 'ssh',
        name: 'x',
        host: 'dev',
        user: 'dev',
        tools: ['claude'],
      })
    ).status,
    400,
    'legacy tools field is rejected',
  )
  assert.equal(
    (
      await call('POST', '/targets', {
        kind: 'ssh',
        name: 'x',
        host: 'dev',
        user: 'dev',
        unknown: true,
      })
    ).status,
    400,
  )
  assert.equal((await call('POST', '/targets', { kind: 'local', name: 'x', host: 'dev' })).status, 400)
  const { body: target } = (await call('POST', '/targets', {
    kind: 'ssh',
    name: ' dev ',
    host: 'dev.example.com',
    user: 'dev',
    port: 2222,
  })) as { body: Target }
  assert.equal(target.name, 'dev')
  assert.equal((await call('PATCH', `/targets/${target.id}`, { name: ' dev-box ' })).body.name, 'dev-box')
  assert.equal((await call('PATCH', `/targets/${target.id}`, { tools: ['kimi'] })).status, 400)
  assert.equal((await call('PATCH', `/targets/${target.id}`, { host: 'other' })).status, 400)
  // On-demand software setup accepts empty body (core software) or specific software IDs, and validates strictly.
  const coreInstall = await call('POST', `/targets/${target.id}/installations`)
  assert.equal(coreInstall.status, 202)
  assert.deepEqual(coreInstall.body.software, ['bash', 'outpost-terminal'])
  const toolInstall = await call('POST', `/targets/${target.id}/installations`, {
    software: ['claude', 'claude-agent-acp'],
  })
  assert.equal(toolInstall.status, 202)
  assert.deepEqual(toolInstall.body.software, ['claude', 'claude-agent-acp'])
  for (const invalid of [{ software: [] }, { software: ['unknown'] }, { software: ['codex', 'codex'] }, { extra: 1 }])
    assert.equal((await call('POST', `/targets/${target.id}/installations`, invalid)).status, 400)
  const base = `/targets/${target.id}/sessions`
  assert.equal((await call('POST', base, { name: 'a', rootDir: 'relative', tool: 'kimi' })).status, 400)
  assert.equal(
    (await call('POST', base, { name: 'a', rootDir: '~/p', tool: 'kimi', conversation: 'not-a-kimi-id' })).status,
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
        conversation: 'session_abc',
        storage: { CODEX_HOME: '/x' },
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
  const { call, addSession } = await setup(t)
  const { target, session } = await addSession()
  const path = `/targets/${target.id}/sessions/${session.id}/connect`
  assert.equal((await call('POST', path, { terminal: 'kitty' })).status, 400)
  const web = (await call('POST', path, {})).body as TerminalTicket
  assert.ok(web.token)
})

test('fork validates input, resolves the source on its target, and inherits launch settings', async t => {
  const { call } = await setup(t)
  const { body: target } = await call('POST', '/targets', {
    kind: 'ssh',
    host: 'forks.example',
    user: 'dev',
    name: 'Forks',
  })
  const base = `/targets/${target.id}/sessions`
  const { body: source } = await call('POST', base, {
    name: 'Source',
    rootDir: '~/project',
    tool: 'claude',
    env: { MODEL: 'fixture' },
    args: '--model "$MODEL"',
  })
  assert.ok(source.id, JSON.stringify(source))
  const path = `${base}/${source.id}/fork`
  const input = { branch: 'feature/login', rootDir: '~/project-feature-login' }
  for (const invalid of [
    { ...input, branch: '' },
    { ...input, branch: 'bad\nbranch' },
    { ...input, rootDir: 'relative' },
    { ...input, tool: 'codex' },
    { ...input, conversation: source.conversations[0].id },
  ])
    assert.equal((await call('POST', path, invalid)).status, 400)
  const { body: other } = await call('POST', '/targets', {
    kind: 'ssh',
    host: 'other.example',
    user: 'dev',
    name: 'Other',
  })
  assert.equal((await call('POST', `/targets/${other.id}/sessions/${source.id}/fork`, input)).status, 404)
  const fork = await call('POST', path, input)
  assert.equal(fork.status, 201)
  assert.equal(fork.body.tool, source.tool)
  assert.deepEqual(fork.body.config.env, source.config.env)
  assert.equal(fork.body.config.args, source.config.args)
  assert.notEqual(fork.body.conversations[0].id, source.conversations[0].id)
})

test('the broker sends the machine and session identity and reports SSH attachment failures', async t => {
  const { port, call, sessions, addSession } = await setup(t)
  const { target, session } = await addSession()
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
  assert.deepEqual(sessions.attached.at(-1), { targetId: target.id, id: session.id, cols: 120, rows: 40 })
  client.input('hello')
  await client.text('echo:hello')
  client.send({ type: 'resize', cols: 100, rows: 30 })
  await client.text('size:100x30')
  client.send({ type: 'paste', id: 'p', data: '/target/screenshot.png' })
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

  const failing = await setup(t)
  failing.sessions.failAttach = true
  const { target: other, session: otherSession } = await failing.addSession()
  const failed = (await failing.call('POST', `/targets/${other.id}/sessions/${otherSession.id}/connect`, {}))
    .body as TerminalTicket
  const broken = new TerminalClient(
    `ws://127.0.0.1:${failing.port}/api/terminal?token=${encodeURIComponent(failed.token)}`,
  )
  t.after(() => broken.socket.terminate())
  assert.deepEqual(await broken.message('closed'), { type: 'closed', reason: 'ended', message: 'Session not found' })
})

test('clients speaking another protocol version are told to update, without spending the launch token', async t => {
  const { port, call, addSession } = await setup(t)
  const { target, session } = await addSession()
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
    history: false,
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
    for (const url of ['/terminal?target=box&session=session', '/desktop']) {
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

test('outbound enrollment binds one machine, recovers a lost reply and invalidates codes on release', async t => {
  const { call, deployment } = await setup(t)
  const target = (await call('POST', '/targets', { kind: 'outbound', name: 'Enrolled machine' })).body
  const targetId: string = target.id
  const setupPath = '/targets/' + targetId + '/enrollment'
  const issue = async () => (await call('POST', setupPath)).body.code as string
  const proof = () => randomBytes(32).toString('base64url')
  const secret = proof()
  const redeem = (code: string, claim = secret, id = targetId) =>
    call('POST', '/machine/enroll', { targetId: id, code, secret: claim })
  const revoke = (claim: string) =>
    call('POST', '/machine/revoke', undefined, { authorization: 'Bearer ' + targetId + '.' + claim })

  const expired = await issue()
  const clock = t.mock.method(Date, 'now', () => new Date().getTime() + 301_000)
  assert.equal((await redeem(expired)).status, 401)
  clock.mock.restore()
  const old = await issue()
  const current = await issue()
  assert.equal((await redeem(old)).status, 401)
  assert.equal((await redeem(current, secret, randomUUID())).status, 401)
  assert.equal((await call('POST', '/machine/enroll', { code: current })).status, 400)
  assert.equal((await call('POST', '/machine/enroll', { code: current, targetId, secret, extra: true })).status, 400)

  // Hold both requests at the workspace read so both present the unused code.
  const workspace = deployment.workspace()
  const get = workspace.get.bind(workspace)
  let release!: () => void
  const waiting = new Promise<void>(resolve => {
    release = resolve
  })
  let readers = 0
  const gate = t.mock.method(workspace, 'get', async (id: string) => {
    if (++readers === 2) release()
    await waiting
    return get(id)
  })
  const [first, second] = await Promise.all([redeem(current), redeem(current)])
  gate.mock.restore()
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.deepEqual(second.body, first.body)
  assert.deepEqual(Object.keys(first.body).sort(), ['socket', 'targetId'])
  assert.equal(first.body.targetId, targetId)
  assert.match(first.body.socket, /^run\/node-[a-f0-9]{32}\.sock$/)
  assert.equal((await call('GET', setupPath)).body.enrolled, true)
  const saved = JSON.parse(
    await readFile(join(deployment.directory, 'machine-enrollments', targetId + '.json'), 'utf8'),
  )
  assert.deepEqual(Object.keys(saved).sort(), ['hash', 'targetId', 'userId'])
  assert.match(saved.hash, /^[a-f0-9]{64}$/)
  assert.deepEqual((await redeem(current)).body, first.body)
  assert.deepEqual((await redeem(expired)).body, first.body)
  assert.equal((await redeem(current, proof())).status, 401)
  assert.equal((await redeem(await issue(), proof())).status, 409)

  const beforeRelease = await issue()
  assert.equal((await revoke(proof())).status, 401)
  assert.equal((await revoke(secret)).status, 204)
  assert.equal((await call('GET', setupPath)).body.enrolled, false)
  assert.equal((await redeem(current)).status, 401)
  assert.equal((await redeem(beforeRelease)).status, 401)
  const next = proof()
  assert.equal((await redeem(await issue(), next)).status, 200)
  const beforeRemoval = await issue()
  assert.equal((await call('DELETE', '/targets/' + targetId)).status, 204)
  assert.equal((await revoke(next)).status, 401)
  assert.equal((await redeem(beforeRemoval, next)).status, 401)
})

test('an invalid enrollment record is reported without changing its contents', async t => {
  const { call, deployment } = await setup(t)
  const { body: target } = await call('POST', '/targets', { kind: 'outbound', name: 'Dev' })
  const path = join(deployment.directory, 'machine-enrollments', target.id + '.json')
  for (const contents of [
    '{',
    JSON.stringify({ targetId: target.id, userId: 'local', hash: 'a'.repeat(64), other: 1 }),
  ]) {
    await writeFile(path, contents)
    const response = await call('GET', '/targets/' + target.id + '/enrollment')
    assert.equal(response.status, 409)
    assert.equal(await readFile(path, 'utf8'), contents)
  }
})

test('a local machine ingress exposes only installer and authenticated machine routes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-machine-ingress-'))
  const deployment = await LocalDeployment.open(directory, 'https://machines.example.test')
  const app = await createApp({ deployment, history: false, software: fakeSoftware })
  t.after(async () => {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  })
  const headers = { host: 'machines.example.test', 'x-outpost-request': '1' }
  for (const url of ['/', '/api/targets', '/api/auth/session', '/log-viewer', '/api/chat', '/api/install/../targets'])
    assert.equal((await app.inject({ url, headers })).statusCode, 403, url)
  assert.equal((await app.inject({ url: '/api/install/machine.sh', headers })).statusCode, 200)
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/machine/enroll',
        headers,
        payload: { targetId: randomUUID(), code: 'A'.repeat(43), secret: 'B'.repeat(43) },
      })
    ).statusCode,
    401,
  )
  assert.equal(
    (await app.inject({ url: '/api/install/machine.sh', headers: { ...headers, origin: 'https://foreign.example' } }))
      .statusCode,
    403,
  )
})
