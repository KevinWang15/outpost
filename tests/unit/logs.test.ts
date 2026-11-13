// The activity log over HTTP: what is recorded, who may read it, and the webhook routes.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { WebSocket } from 'ws'
import type { LogView, Webhook } from '../../shared/logs'
import type { Session, Target } from '../../shared/model'
import { createApp } from '../../backend/app'
import type { Deployment } from '../../backend/deployment'
import { LocalDeployment } from '../../backend/deployment'
import { HostedDeployment } from '../../backend/hosted/deployment'
import { FakeSessions, fakeSoftware } from './fakes'

async function start(t: TestContext, deployment: (directory: string) => Promise<Deployment>) {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-logs-'))
  const app = await createApp({
    history: false,
    deployment: await deployment(directory),
    sessions: new FakeSessions(),
    software: fakeSoftware,
    multiplex: false,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
  t.after(async () => {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  })
  const call = async <T>(method: string, path: string, body?: unknown, cookie = '') => {
    const response = await fetch(base + path, {
      method,
      headers: {
        'x-outpost-request': '1',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const json = response.headers.get('content-type')?.includes('application/json')
    return { status: response.status, body: (json ? await response.json() : undefined) as T, response }
  }
  /** Entries of the account's stream, oldest first. */
  const entries = async (view: LogView, cookie = '') =>
    (
      await call<{ entries: { msg: string; lg: string; th: string; fields: Record<string, string> }[] }>(
        'GET',
        `/log-viewer/api/logs/${encodeURIComponent(`s:${view.channel}`)}/entries?from=0&count=100`,
        undefined,
        cookie,
      )
    ).body.entries
  return { base, call, entries }
}

test('changes are recorded in the account’s log, which only Outpost writes', async t => {
  const { base, call, entries } = await start(t, directory => LocalDeployment.open(directory))
  const view = (await call<LogView>('GET', '/api/logs')).body
  assert.equal(view.path, '/log-viewer/')
  const target = (
    await call<Target>('POST', '/api/targets', {
      kind: 'ssh',
      name: 'dev',
      host: 'dev.example.com',
      user: 'dev',
      tools: ['claude'],
    })
  ).body
  const session = (
    await call<Session>('POST', `/api/targets/${target.id}/sessions`, { name: 'Build', rootDir: '~/p', tool: 'claude' })
  ).body
  await call('PATCH', `/api/targets/${target.id}/sessions/${session.id}`, {
    revision: session.config.revision,
    instructions: 'Be brief.',
  })
  assert.deepEqual(
    (await entries(view)).map(entry => [entry.lg, entry.msg]),
    [
      ['machine', 'dev was added'],
      ['session', 'Build was created'],
      ['session', 'Build was edited: instructions'],
    ],
  )
  const [, created] = await entries(view)
  assert.equal(created.th, 'dev')
  assert.equal(created.fields.session, 'Build')

  // The viewer's pages come from Outpost and may be framed only by it.
  const page = await fetch(`${base}/log-viewer/embed.html`)
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN')
  // Nothing but Outpost writes the log, opens files or adds rules that call out.
  const stream = `/log-viewer/api/v1/streams/${view.channel}/entries`
  assert.equal((await call('POST', stream, { entries: [{ message: 'forged' }] })).status, 401)
  const rule = { name: 'x', criteria: {}, actions: { webhook: 'http://127.0.0.1:1/' } }
  assert.equal(
    (await call('POST', `/log-viewer/api/logs/${encodeURIComponent(`s:${view.channel}`)}/rules`, rule)).status,
    401,
  )
  assert.equal((await call('POST', '/log-viewer/api/logs/open', { path: '/etc/passwd' })).status, 404)

  // Live updates arrive over the viewer's WebSocket, for this account's stream only.
  const socket = new WebSocket(`${base.replace('http', 'ws')}/log-viewer/ws`)
  const frames: { type: string; id?: string; code?: string }[] = []
  socket.on('message', data => frames.push(JSON.parse(String(data))))
  await new Promise(resolve => socket.once('open', resolve))
  socket.send(JSON.stringify({ type: 'sub', id: `s:${view.channel}` }))
  socket.send(JSON.stringify({ type: 'sub', id: 's:another-account' }))
  await call('DELETE', `/api/targets/${target.id}/sessions/${session.id}`)
  for (let attempt = 0; attempt < 100 && frames.length < 3; attempt++)
    await new Promise(resolve => setTimeout(resolve, 20))
  socket.close()
  assert.ok(frames.some(frame => frame.id === `s:${view.channel}` && frame.type !== 'error'))
  assert.ok(frames.some(frame => frame.type === 'error' && frame.code === 'view_auth_required'))
  assert.equal((await entries(view)).at(-1)?.msg, 'Build was deleted')
})

test('webhooks are managed per account; header values never come back', async t => {
  const { call } = await start(t, directory => LocalDeployment.open(directory))
  const input = {
    name: 'Alerts',
    url: 'https://example.com/hook',
    headers: [{ name: 'Authorization', value: 'Bearer secret' }],
    kinds: ['agent'],
    level: 'warning',
    enabled: true,
  }
  assert.equal((await call('POST', '/api/webhooks', { ...input, url: 'ftp://example.com' })).status, 400)
  const created = await call<Webhook>('POST', '/api/webhooks', input)
  assert.equal(created.status, 201)
  assert.deepEqual(created.body.headers, [{ name: 'Authorization' }])
  const listed = (await call<Webhook[]>('GET', '/api/webhooks')).body
  assert.equal(JSON.stringify(listed).includes('secret'), false)
  const paused = await call<Webhook>('PUT', `/api/webhooks/${created.body.id}`, {
    ...input,
    headers: [{ name: 'Authorization' }],
    enabled: false,
  })
  assert.equal(paused.body.enabled, false)
  assert.equal((await call('DELETE', `/api/webhooks/${created.body.id}`)).status, 204)
  assert.equal((await call('DELETE', `/api/webhooks/${created.body.id}`)).status, 404)
})

test('hosted accounts each read only their own log', async t => {
  const { base, call, entries } = await start(t, directory =>
    HostedDeployment.open({ directory, publicUrl: 'http://127.0.0.1:5173', mailer: null }),
  )
  const account = async (email: string) => {
    const signup = await call<{ devUrl: string }>('POST', '/api/auth/signup', {
      email,
      name: email.split('@')[0],
      password: 'a long password',
    })
    const verified = await call('POST', '/api/auth/verify-email', {
      token: new URL(signup.body.devUrl).searchParams.get('token'),
    })
    return verified.response.headers.get('set-cookie')!.split(';')[0]
  }
  const alice = await account('alice@example.com'),
    bob = await account('bob@example.com')
  await call(
    'POST',
    '/api/targets',
    { kind: 'ssh', name: 'alice-box', host: 'a.example.com', user: 'a', tools: ['claude'] },
    alice,
  )
  const aliceView = (await call<LogView>('GET', '/api/logs', undefined, alice)).body
  const bobView = (await call<LogView>('GET', '/api/logs', undefined, bob)).body
  assert.notEqual(aliceView.channel, bobView.channel)
  assert.deepEqual(
    (await entries(aliceView, alice)).map(entry => entry.msg),
    ['alice-box was added'],
  )
  const sources = await call<{ sources: { id: string }[] }>('GET', '/log-viewer/api/logs', undefined, bob)
  assert.deepEqual(
    sources.body.sources.map(source => source.id),
    [`s:${bobView.channel}`],
  )
  const stolen = await fetch(
    `${base}/log-viewer/api/logs/${encodeURIComponent(`s:${aliceView.channel}`)}/entries?from=0&count=10`,
    { headers: { cookie: bob } },
  )
  assert.ok(stolen.status === 401 || stolen.status === 403)
  assert.equal((await fetch(`${base}/log-viewer/embed.html`)).status, 401, 'signed out')
})
