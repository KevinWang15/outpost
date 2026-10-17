import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Session, Target } from '../../shared/model'
import type { ConnectResponse } from '../../shared/protocol'
import { createApp } from '../../backend/app'
import { HostedDeployment } from '../../backend/hosted/deployment'
import { TerminalClient } from '../integration/helpers'
import { FakeSessions, fakeSoftware } from './fakes'

test(
  'hosted accounts: verified sign-in, isolated workspaces, and sign-out revokes terminals',
  { timeout: 60_000 },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'outpost-hosted-'))
    const deployment = await HostedDeployment.open({ directory, publicUrl: 'http://127.0.0.1:5173', mailer: null })
    const app = await createApp({ deployment, sessions: new FakeSessions(), software: fakeSoftware, multiplex: false })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const port = (app.server.address() as { port: number }).port
    t.after(async () => {
      await app.close()
      await rm(directory, { recursive: true, force: true })
    })
    const call = async (method: string, url: string, payload?: unknown, cookie = '') => {
      const response = await app.inject({
        method: method as 'GET',
        url: `/api${url}`,
        payload: payload as object,
        headers: { host: `127.0.0.1:${port}`, 'x-outpost-request': '1', ...(cookie ? { cookie } : {}) },
      })
      return {
        status: response.statusCode,
        body: response.body ? JSON.parse(response.body) : undefined,
        cookie: [response.headers['set-cookie']].flat()[0]?.split(';')[0] ?? '',
      }
    }
    const account = async (email: string) => {
      const signup = await call('POST', '/auth/signup', {
        email,
        name: email.split('@')[0],
        password: 'a long password',
      })
      assert.equal(signup.status, 201)
      const verified = await call('POST', '/auth/verify-email', {
        token: new URL(signup.body.devUrl).searchParams.get('token'),
      })
      assert.equal(verified.status, 200)
      return verified.cookie
    }
    assert.equal((await call('GET', '/targets')).status, 401)
    const alice = await account('alice@example.com'),
      bob = await account('bob@example.com')

    assert.match((await call('GET', '/account/ssh-key', undefined, alice)).body.publicKey, /^ssh-ed25519 /)
    assert.equal((await call('POST', '/targets', { kind: 'local', name: 'x', tools: ['claude'] }, alice)).status, 400)
    assert.equal(
      (
        await call(
          'POST',
          '/targets',
          { kind: 'ssh', name: 'x', host: 'dev', identityFile: '~/.ssh/id', tools: ['claude'] },
          alice,
        )
      ).status,
      400,
    )
    const target = (
      await call('POST', '/targets', { kind: 'ssh', name: 'dev', host: 'dev.example.com', tools: ['claude'] }, alice)
    ).body as Target
    assert.deepEqual((await call('GET', '/targets', undefined, bob)).body, [])
    assert.equal((await call('GET', `/targets/${target.id}/sessions`, undefined, bob)).status, 404)
    assert.deepEqual((await call('GET', '/environment', undefined, alice)).body, {
      mode: 'hosted',
      localTargets: false,
    })

    const session = (
      await call('POST', `/targets/${target.id}/sessions`, { name: 'Build', rootDir: '~/p', tool: 'claude' }, alice)
    ).body as Session
    const connections = []
    for (const choice of ['web', 'desktop']) {
      assert.equal(
        (await call('POST', `/targets/${target.id}/sessions/${session.id}/connect`, { terminal: choice })).status,
        401,
      )
      const { token, id } = (
        await call('POST', `/targets/${target.id}/sessions/${session.id}/connect`, { terminal: choice }, alice)
      ).body as ConnectResponse
      assert.deepEqual((await call('GET', `/connections/${id}`, undefined, bob)).body, { status: 'pending' })
      // WebSocket authorization uses the scoped grant, with no account cookie.
      const terminal = new TerminalClient(`ws://127.0.0.1:${port}/api/terminal?token=${encodeURIComponent(token)}`)
      t.after(() => terminal.socket.terminate())
      const hello = await terminal.message('hello')
      await terminal.message('ready')
      const replay = new TerminalClient(`ws://127.0.0.1:${port}/api/terminal?token=${encodeURIComponent(token)}`)
      t.after(() => replay.socket.terminate())
      assert.equal((await replay.message('closed')).reason, 'expired')
      assert.equal(
        (await call('GET', '/targets', undefined, `outpost_session=${hello.resume}`)).status,
        401,
        'terminal grants are not account sessions',
      )
      connections.push({ terminal, hello })
    }

    const upload = (token: string, cookie = '') =>
      app.inject({
        method: 'POST',
        url: '/api/terminal/image',
        payload: Buffer.from([137, 80, 78, 71]),
        headers: {
          host: `127.0.0.1:${port}`,
          'x-outpost-request': '1',
          'content-type': 'image/png',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(cookie ? { cookie } : {}),
        },
      })
    assert.equal((await upload('', alice)).statusCode, 401, 'account cookie cannot replace scoped authorization')
    for (const { hello } of connections)
      assert.equal((await upload(hello.resume)).statusCode, 200, 'upload needs no cookie')
    assert.equal((await call('POST', '/auth/logout', undefined, alice)).status, 204)
    for (const { terminal, hello } of connections) {
      assert.equal((await upload(hello.resume)).statusCode, 401, 'logout also revokes image uploads')
      const closed = await terminal.message('closed')
      assert.equal(closed.reason, 'expired', 'open terminals close within the revocation sweep')
      const resumed = new TerminalClient(
        `ws://127.0.0.1:${port}/api/terminal?token=${encodeURIComponent(hello.resume)}`,
      )
      t.after(() => resumed.socket.terminate())
      assert.equal((await resumed.message('closed')).reason, 'expired', 'resume tokens die with the login')
    }
  },
)
