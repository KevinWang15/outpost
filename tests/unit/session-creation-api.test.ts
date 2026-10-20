import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApp } from '../../backend/app'
import { LocalDeployment } from '../../backend/deployment'
import { HostedDeployment } from '../../backend/hosted/deployment'
import { parseDesktopLoginCallback } from '../../shared/desktopAuth'
import { FakeSessions, fakeSoftware } from './fakes'

for (const mode of ['local', 'hosted'] as const) {
  test(`${mode} desktop creation requires a request identity, returns catalogue metadata, and scopes retries`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'outpost-create-api-'))
    const deployment =
      mode === 'local'
        ? await LocalDeployment.open(directory)
        : await HostedDeployment.open({ directory, publicUrl: 'http://127.0.0.1:5173', mailer: null })
    const sessions = new FakeSessions()
    const keys: (string | undefined)[] = []
    const create = sessions.create.bind(sessions)
    // HTTP contract and capability boundary; durable replay/concurrency runs
    // against real target processes in test_runtime.py.
    sessions.create = async (context, input, key?: string) => {
      keys.push(key)
      return create(context, input)
    }
    const app = await createApp({ deployment, sessions, software: fakeSoftware, multiplex: false })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const port = (app.server.address() as { port: number }).port
    t.after(async () => {
      await app.close()
      await rm(directory, { recursive: true, force: true })
    })
    let cookie = ''
    const call = async (method: 'GET' | 'POST', path: string, payload?: object, token?: string) => {
      const response = await app.inject({
        method,
        url: '/api' + path,
        payload,
        headers: {
          host: `127.0.0.1:${port}`,
          'x-outpost-request': '1',
          ...(token ? { authorization: `Bearer ${token}` } : cookie ? { cookie } : {}),
        },
      })
      return {
        status: response.statusCode,
        body: response.body ? JSON.parse(response.body) : undefined,
        cookie: [response.headers['set-cookie']].flat()[0]?.split(';')[0] ?? '',
      }
    }
    let accountId = 'local'
    if (mode === 'hosted') {
      const signup = await call('POST', '/auth/signup', {
        email: 'creator@example.com',
        name: 'Creator',
        password: 'fixture password long enough',
      })
      const verified = await call('POST', '/auth/verify-email', {
        token: new URL(signup.body.devUrl).searchParams.get('token'),
      })
      assert.equal(verified.status, 200)
      cookie = verified.cookie
      accountId = (await call('GET', '/auth/session')).body.user.id
    }
    const targetInput = { kind: 'ssh', name: 'Target', host: 'fixture.example', tools: ['codex'] }
    const target = (await call('POST', '/targets', targetInput)).body
    const input = { name: 'Created', rootDir: '/tmp/project', tool: 'codex' }
    const path = `/desktop/targets/${target.id}/sessions`
    const requestId = randomUUID()
    assert.equal((await call('POST', path, { requestId, input })).status, 401)
    assert.equal(keys.length, 0)
    async function login() {
      const verifier = randomBytes(32).toString('base64url')
      const start = await call('POST', '/desktop/authorizations', {
        state: randomBytes(32).toString('base64url'),
        challenge: createHash('sha256').update(verifier).digest('base64url'),
      })
      const approval = await call('POST', `/desktop/authorizations/${start.body.requestId}`, { allow: true, accountId })
      const { code } = parseDesktopLoginCallback(approval.body.callback)
      return (await call('POST', '/desktop/token', { code, verifier })).body.token as string
    }
    const token = await login()
    for (const invalid of [input, { input }, { requestId: '../bad', input }, { requestId, input, extra: true }])
      assert.equal((await call('POST', path, invalid, token)).status, 400)
    const result = await call('POST', path, { requestId, input }, token)
    assert.equal(result.status, 201)
    assert.equal(result.body.title, 'Created · Target')
    assert.equal(result.body.targetId, target.id)
    assert.equal(result.body.detail, 'codex · /tmp/project · ready')
    assert.equal(result.body.token, undefined)
    assert.deepEqual((await call('GET', path, undefined, token)).body[0], result.body)
    assert.match(keys[0]!, /^[0-9a-f]{64}$/)
    // The same account can recover a request after signing in again.
    await call('POST', path, { requestId, input }, await login())
    assert.equal(keys[0], keys[1])
    const otherTarget = (await call('POST', '/targets', { ...targetInput, name: 'Other' })).body
    await call('POST', `/desktop/targets/${otherTarget.id}/sessions`, { requestId, input }, token)
    assert.notEqual(keys[0], keys[2])
    await call('POST', path, { requestId: randomUUID(), input }, token)
    assert.notEqual(keys[0], keys[3])
    await call('POST', '/desktop/logout', undefined, token)
    assert.equal((await call('POST', path, { requestId, input }, token)).status, 401)
    assert.equal(keys.length, 4)
  })
}
