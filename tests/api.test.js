import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApp } from '../backend/app.ts'
import { TargetStore } from '../backend/store.ts'
import { AppError } from '../backend/errors.ts'

const environment = { home: '/root', username: 'root', uid: 0, platform: 'linux', shell: '/bin/bash' }
const report = { environment, checkedAt: '2026-09-30T00:00:00Z', software: [] }
const headers = { 'x-outpost-request': '1' }
async function fixture(t, service = {}, desktop = { available: async () => ({ os: 'linux', terminals: [], recommendedId: null }) }, software = { inspect: async () => report }) {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-api-'))
  const store = new TargetStore(directory)
  const app = await createApp({ store, service, desktop, software })
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }) })
  const request = (method, url, payload, extra = {}) => app.inject({ method, url, payload, headers: { ...headers, ...extra } })
  return { app, directory, store, request }
}

test('completion acknowledgement is validated, scoped, uncached, and never cleared by reading connection options', async t => {
  const calls = []
  const token = 'a'.repeat(64)
  const { request, directory } = await fixture(t, {
    get: async (_target, id) => ({ id, activity: { state: 'finished', completionId: token } }),
    acknowledge: async (target, id, completionId) => { calls.push({ targetId: target.id, id, completionId }); return { id, activity: { state: 'idle' } } },
  })
  const target = (await request('POST', '/api/targets', { kind: 'ssh', name: 'Activity', host: 'dev.example.com', tools: ['codex'], backends: ['tmux'] })).json()
  const base = `/api/targets/${target.id}/sessions/work`
  assert.equal((await request('GET', base)).json().activity.state, 'finished')
  assert.equal((await request('POST', `${base}/connect`)).statusCode, 200)
  assert.equal(calls.length, 0)
  for (const input of [{}, { completionId: '' }, { completionId: 'x'.repeat(64) }, { completionId: token, extra: true }]) {
    assert.equal((await request('POST', `${base}/acknowledge`, input)).statusCode, 400)
  }
  const result = await request('POST', `${base}/acknowledge`, { completionId: token })
  assert.equal(result.statusCode, 200, result.body)
  assert.equal(result.json().activity.state, 'idle')
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.deepEqual(calls, [{ targetId: target.id, id: 'work', completionId: token }])
  assert.equal((await request('POST', '/api/targets/missing/sessions/work/acknowledge', { completionId: token })).statusCode, 404)
  assert.equal((await readFile(join(directory, 'targets.json'), 'utf8')).includes(token), false)
})

test('conversation search is live, validated, scoped to the requested target, uncached, and never persisted in manager storage', async t => {
  const calls = []
  const { request, directory } = await fixture(t, {
    search: async (target, input, signal) => {
      calls.push({ target: target.id, input, signal })
      return { sessions: [{ tool: 'codex', cliSessionId: 'coding-id', excerpt: `PRIVATE_SEARCH_EXCERPT_${calls.length}` }], truncated: false, warnings: [] }
    },
    get: async (target, id) => ({ id, target: target.id, cliSessionId: 'native-id' }),
  })
  const first = (await request('POST', '/api/targets', { name: 'First', tools: ['codex'], kind: 'ssh', host: 'first.example.com', backends: ['tmux'] })).json()
  const second = (await request('POST', '/api/targets', { name: 'Second', tools: ['claude'], kind: 'ssh', host: 'second.example.com', backends: ['tmux'] })).json()
  const path = `/api/targets/${first.id}/coding-sessions/search`
  for (const input of [{ query: 'any keyword' }, { query: 'any keyword' }, { query: 'literal [.*] $(command)', tool: 'kimi' }]) {
    const response = await request('POST', path, input)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.json().sessions[0].excerpt, `PRIVATE_SEARCH_EXCERPT_${calls.length}`)
    assert.deepEqual(calls.at(-1).input, input)
    assert.ok(calls.at(-1).signal instanceof AbortSignal)
    assert.equal(calls.at(-1).target, first.id)
  }
  assert.equal((await request('POST', `/api/targets/${second.id}/coding-sessions/search`, { query: 'another' })).statusCode, 200)
  assert.equal(calls.at(-1).target, second.id)
  for (const input of [{ query: '' }, { query: ' ' }, { query: 'x'.repeat(257) }, { query: 'line\nbreak' }, { query: 'x', tool: 'gemini' }, { query: 'x', extra: true }, {}]) {
    assert.equal((await request('POST', path, input)).statusCode, 400)
  }
  assert.equal(calls.length, 4)
  assert.equal((await request('POST', '/api/targets/missing/coding-sessions/search', { query: 'x' })).statusCode, 404)
  const config = await readFile(join(directory, 'targets.json'), 'utf8')
  assert.equal(config.includes('PRIVATE_SEARCH_EXCERPT'), false)
  assert.equal(config.includes('any keyword'), false)
  const session = await request('GET', `/api/targets/${first.id}/sessions/work`)
  assert.deepEqual(session.json(), { id: 'work', target: first.id, cliSessionId: 'native-id' })
})

test('linking accepts literal native IDs and rejects malformed IDs or storage paths before contacting the target', async t => {
  const calls = []
  const { request } = await fixture(t, { create: async (_target, input) => { calls.push(input); return input } })
  const target = (await request('POST', '/api/targets', { name: 'Links', tools: ['codex', 'claude', 'kimi'], kind: 'ssh', host: 'dev.example.com', backends: ['tmux'] })).json()
  const path = `/api/targets/${target.id}/sessions`
  const input = { name: 'Linked', tool: 'claude', backend: 'tmux', rootDir: '/home/dev/project', cliSessionId: '12345678-1234-4123-8123-123456789012', cliSessionEnv: { CLAUDE_CONFIG_DIR: '/home/dev/.claude' } }
  assert.equal((await request('POST', path, input)).statusCode, 201)
  assert.deepEqual(calls[0], input)
  for (const extra of [{ cliSessionId: '../escape' }, { cliSessionId: '$(command)' }, { cliSessionId: null },
    { cliSessionEnv: { PATH: '/bin' } }, { cliSessionEnv: { CLAUDE_CONFIG_DIR: 'relative' } }, { cliSessionId: undefined },
    { cliSessionEnv: { CODEX_HOME: '/home/dev/.codex' } }, { cliSessionId: 'session_wrong_tool' },
    { tool: 'kimi', cliSessionEnv: { KIMI_CODE_HOME: '/home/dev/.kimi-code' } },
    { tool: 'kimi', cliSessionId: 'session_current', cliSessionEnv: { KIMI_SHARE_DIR: '/home/dev/.kimi' } }]) {
    assert.equal((await request('POST', path, { ...input, ...extra })).statusCode, 400)
  }
  assert.equal(calls.length, 1)
  for (const identity of [
    { tool: 'codex', cliSessionEnv: { CODEX_HOME: '/home/dev/.codex' } },
    { tool: 'kimi', cliSessionId: 'session_current', cliSessionEnv: { KIMI_CODE_HOME: '/home/dev/.kimi-code' } },
  ]) assert.equal((await request('POST', path, { ...input, ...identity })).statusCode, 201)
  assert.equal(calls.length, 3)
})

test('stores only target configuration, persists across restarts, and forgets targets without contacting SSH', async t => {
  const { request, store, directory } = await fixture(t)
  const added = await request('POST', '/api/targets', { backends: ['dtach'], name: 'Dev machine', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev.example.com' })
  assert.equal(added.statusCode, 201)
  const target = added.json()
  const config = JSON.parse(await readFile(join(directory, 'targets.json'), 'utf8'))
  assert.equal(config.targets[0].name, 'Dev machine')
  assert.equal(config.sessions, undefined)
  assert.equal((await stat(join(directory, 'targets.json'))).mode & 0o777, 0o600)
  const restarted = new TargetStore(directory)
  assert.equal((await restarted.get(target.id)).host, 'dev.example.com')
  assert.equal(await store.secret(), await restarted.secret())
  assert.equal((await request('POST', '/api/targets', { backends: ['dtach'], name: 'dev machine', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'elsewhere' })).statusCode, 409)
  assert.equal((await request('DELETE', `/api/targets/${target.id}`)).statusCode, 204)
  assert.equal((await request('GET', '/api/targets')).json().length, 0)
})

test('rejects SSH option injection, malformed input, cross-site requests, and DNS rebinding', async t => {
  const { request, app } = await fixture(t)
  for (const host of ['-oProxyCommand=evil', 'root@host', 'host;touch /tmp/no', 'host\nother', 'host/path', '']) {
    assert.equal((await request('POST', '/api/targets', { backends: ['dtach'], name: 'test', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host })).statusCode, 400, host)
  }
  for (const extra of [{ port: 0 }, { port: '22' }, { identityFile: '-x' }, { backends: ['screen'] }, { backends: ['tmux;echo bad'] }, { backends: null }, { backends: undefined }, { backends: 'tmux' }, { backends: [] }, { backends: ['tmux', 'tmux'] }, { backends: ['tmux', 'dtach', 'tmux'] }, { extra: true }]) {
    assert.equal((await request('POST', '/api/targets', { backends: ['dtach'], name: 'test', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev', ...extra })).statusCode, 400)
  }
  assert.equal((await request('POST', '/api/targets', { backends: ['dtach'], name: 'test', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev' }, { origin: 'https://evil.example' })).statusCode, 403)
  assert.equal((await app.inject({ method: 'POST', url: '/api/targets', payload: { name: 'test', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev', backends: ['dtach'] } })).statusCode, 403)
  assert.equal((await request('GET', '/api/targets', undefined, { host: 'evil.example' })).statusCode, 403)
})

test('backend selections persist, update atomically with tools, and constrain only new sessions', async t => {
  const calls = []
  const { request, directory } = await fixture(t, {
    create: async (_target, input) => { calls.push(input); return input },
    get: async (_target, id) => ({ id, backend: 'tmux' }),
  })
  for (const backends of [['tmux'], ['dtach'], ['tmux', 'dtach']]) {
    const added = await request('POST', '/api/targets', { name: backends.join('+'), tools: ['codex'], kind: 'ssh', host: 'dev', backends })
    assert.equal(added.statusCode, 201)
    const target = added.json()
    assert.deepEqual(target.backends, backends)
    assert.deepEqual((await new TargetStore(directory).get(target.id)).backends, backends)
    const base = `/api/targets/${target.id}`
    for (const backend of backends) {
      const input = { backend, tool: 'codex', name: 'Work', rootDir: '/root' }
      const created = await request('POST', `${base}/sessions`, input)
      assert.equal(created.statusCode, 201, created.body)
      assert.deepEqual(calls.at(-1), input)
    }
    const requirements = { backends: ['dtach'], tools: ['kimi'] }
    const updated = await request('PATCH', `${base}/requirements`, requirements)
    assert.equal(updated.statusCode, 200, updated.body)
    const saved = await new TargetStore(directory).get(target.id)
    assert.deepEqual(saved.backends, ['dtach'])
    assert.deepEqual(saved.tools, ['kimi'])
    assert.equal((await request('POST', `${base}/sessions`, { backend: 'tmux', tool: 'kimi', name: 'Unselected', rootDir: '/root' })).statusCode, 400)
    assert.equal((await request('POST', `${base}/sessions`, { backend: 'dtach', tool: 'codex', name: 'Unselected', rootDir: '/root' })).statusCode, 400)
    assert.equal((await request('POST', `${base}/sessions/existing-tmux/connect`)).statusCode, 200, 'deselecting a backend does not block existing connections')
    for (const invalid of [{ backends: [], tools: ['kimi'] }, { backends: ['tmux', 'tmux'], tools: ['kimi'] }, { backends: ['dtach'], tools: [] }, { backends: ['screen'], tools: ['kimi'] }, { tools: ['kimi'] }]) {
      assert.equal((await request('PATCH', `${base}/requirements`, invalid)).statusCode, 400)
      assert.deepEqual((await new TargetStore(directory).get(target.id)).backends, ['dtach'], 'invalid selections are not saved')
    }
  }
  assert.equal(calls.length, 4, 'invalid selections never reach session creation')
})

test('accepts native Windows, Unix, and home-relative SSH identity paths', async t => {
  const { request } = await fixture(t)
  const paths = ['C:\\Users\\Dev User\\.ssh\\id_ed25519', 'D:/keys/dev key', '\\\\server\\share\\key', '~\\.ssh\\key', '~/keys/dev', '/home/dev/key']
  for (const [index, identityFile] of paths.entries()) {
    const response = await request('POST', '/api/targets', { backends: ['tmux'], name: `Path ${index}`, tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev', identityFile })
    assert.equal(response.statusCode, 201, response.body)
    assert.equal(response.json().identityFile, identityFile)
  }
  for (const identityFile of ['C:relative', 'keys/id', 'C:\\bad\nkey']) {
    assert.equal((await request('POST', '/api/targets', { backends: ['tmux'], name: 'Bad path', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev', identityFile })).statusCode, 400)
  }
})

test('session creation requires a supported coding tool and forwards the choice unchanged', async t => {
  const calls = []
  const { request } = await fixture(t, {
    create: async (_target, input) => { calls.push(input); return { ...input, id: 'session' } },
  })
  const target = (await request('POST', '/api/targets', { backends: ['tmux'], name: 'Tools', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev' })).json()
  const path = `/api/targets/${target.id}/sessions`
  for (const tool of ['codex', 'kimi', 'claude']) {
    const input = { name: tool, tool, backend: 'tmux', rootDir: '/root/project', createDirectory: true }
    const response = await request('POST', path, input)
    assert.equal(response.statusCode, 201, response.body)
    assert.equal(response.json().tool, tool)
    assert.deepEqual(calls.at(-1), input)
  }
  for (const tool of [undefined, null, '', 'gemini', 'claude; touch /tmp/INJECTED', '/bin/sh', ['codex']]) {
    assert.equal((await request('POST', path, { name: 'Invalid', tool, backend: 'tmux', rootDir: '/root/project' })).statusCode, 400)
  }
  for (const backend of [undefined, null, '', 'screen', 'tmux; touch /tmp/INJECTED', ['tmux'], 'dtach']) {
    assert.equal((await request('POST', path, { name: 'Invalid', tool: 'codex', backend, rootDir: '/root/project' })).statusCode, 400)
  }
  assert.equal(calls.length, 3, 'invalid tools never reach the target')
})

test('optional session environment and arguments are preserved and validated before reaching the target', async t => {
  const calls = []
  const { request } = await fixture(t, { create: async (_target, input) => { calls.push(input); return input } })
  const target = (await request('POST', '/api/targets', { backends: ['tmux'], name: 'Options', tools: ['codex'], kind: 'ssh', host: 'dev' })).json()
  const path = `/api/targets/${target.id}/sessions`
  const base = { name: 'Work', tool: 'codex', backend: 'tmux', rootDir: '/root/project' }
  const input = { ...base, args: '--message "$MESSAGE" --label "two words"', env: { MESSAGE: "literal $HOME $(echo no) 'quotes'\nnext é", EMPTY: '', _VALID_1: 'yes' } }
  assert.equal((await request('POST', path, input)).statusCode, 201)
  assert.deepEqual(calls.at(-1), input)
  assert.equal((await request('POST', path, { ...base, env: {}, args: '' })).statusCode, 201)
  assert.equal((await request('POST', path, base)).statusCode, 201)
  for (const invalid of [
    { args: null }, { args: [] }, { args: 'bad\0argument' }, { args: 'x'.repeat(8193) },
    { env: null }, { env: [] }, { env: { '': 'value' } }, { env: { '1NAME': 'value' } },
    { env: { 'BAD-NAME': 'value' } }, { env: { 'NAME\n': 'value' } }, { env: { 'NAME;echo': 'value' } },
    { env: { NAME: 1 } }, { env: { NAME: null } }, { env: { NAME: 'bad\0value' } },
    { env: { NAME: 'x'.repeat(4097) } }, { env: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`VAR_${i}`, ''])) },
    { env: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`VAR_${i}`, 'x'.repeat(4096)])) },
  ]) assert.equal((await request('POST', path, { ...base, ...invalid })).statusCode, 400, JSON.stringify(invalid).slice(0, 100))
  assert.equal(calls.length, 3, 'invalid launch settings never reach SSH')
})

test('directory suggestions fetch live from the selected target and validate literal path prefixes', async t => {
  const calls = []
  const { request } = await fixture(t, {
    directories: async (target, path) => {
      calls.push({ targetId: target.id, path })
      if (path === '/unreachable/') throw new AppError('SSH unavailable', 502)
      return { directories: [`/root/live-${calls.length}/`], truncated: false }
    },
  })
  const target = (await request('POST', '/api/targets', { backends: ['tmux'], name: 'Paths', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev' })).json()
  const base = `/api/targets/${target.id}/directories`
  for (const path of ['', '~', '~/', '/', "/root/project's $(touch nope) & [x]", '/root/same', '/root/same']) {
    const response = await request('GET', `${base}?path=${encodeURIComponent(path)}`)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.deepEqual(calls.at(-1), { targetId: target.id, path })
    assert.deepEqual(response.json(), { directories: [`/root/live-${calls.length}/`], truncated: false })
  }
  for (const path of ['relative', '~other', '/bad\npath', '/bad\0path', '/' + 'a'.repeat(4096)]) {
    assert.equal((await request('GET', `${base}?path=${encodeURIComponent(path)}`)).statusCode, 400)
  }
  assert.equal((await request('GET', base)).statusCode, 400)
  assert.equal((await request('GET', `${base}?path=/&extra=yes`)).statusCode, 400)
  assert.equal((await request('GET', '/api/targets/missing/directories?path=/')).statusCode, 404)
  assert.equal(calls.length, 7, 'invalid requests never reach SSH')
  const failed = await request('GET', `${base}?path=/unreachable/`)
  assert.equal(failed.statusCode, 502)
  assert.equal(failed.headers['cache-control'], 'no-store')
  assert.deepEqual(failed.json(), { message: 'SSH unavailable' })
})

test('image uploads accept larger bodies only on their route, preserve target/session scope, and require valid authenticated input', async t => {
  const calls = []
  const result = { path: '/home/dev/image.png', reference: '/home/dev/image.png', injected: false }
  const { request, app } = await fixture(t, {
    pasteImage: async (target, id, image) => { calls.push({ target: target.id, id, image }); return result },
  })
  const target = (await request('POST', '/api/targets', { kind: 'ssh', name: 'Images', host: 'dev.example.com', backends: ['tmux'], tools: ['codex'] })).json()
  const path = `/api/targets/${target.id}/sessions/work/image`
  const image = { data: Buffer.alloc(200 * 1024).toString('base64'), mediaType: 'image/png' }
  const uploaded = await request('POST', path, image)
  assert.equal(uploaded.statusCode, 200, uploaded.body)
  assert.equal(uploaded.headers['cache-control'], 'no-store')
  assert.deepEqual(uploaded.json(), result)
  assert.deepEqual(calls, [{ target: target.id, id: 'work', image }])
  for (const invalid of [{}, { ...image, data: 'not base64!' }, { ...image, mediaType: 'text/plain' }, { ...image, extra: true }, { ...image, data: null }]) {
    assert.equal((await request('POST', path, invalid)).statusCode, 400)
  }
  assert.equal((await app.inject({ method: 'POST', url: path, payload: image })).statusCode, 403)
  assert.equal((await request('POST', path, image, { origin: 'https://evil.example' })).statusCode, 403)
  assert.equal((await request('POST', '/api/targets/missing/sessions/work/image', image)).statusCode, 404)
  assert.equal((await request('POST', `/api/targets/${target.id}/sessions`, { name: 'Huge', backend: 'tmux', tool: 'codex', rootDir: '/root', args: image.data })).statusCode, 413)
  assert.equal(calls.length, 1, 'invalid or unauthenticated uploads never reach the target')
})

for (const operation of ['directories', 'sessions', 'connect', 'software', 'script']) test(`disconnecting ${operation} cancels its target read`, { timeout: 5000 }, async t => {
  let started, cancelled
  const didStart = new Promise(resolve => { started = resolve })
  const didCancel = new Promise(resolve => { cancelled = resolve })
  const read = async signal => {
    started(signal)
    await new Promise(resolve => signal.addEventListener('abort', () => { cancelled(); resolve() }, { once: true }))
    throw new AppError('Target read cancelled', 502)
  }
  const { app, request } = await fixture(t, {
    directories: (_target, _path, signal) => read(signal),
    list: (_target, signal) => read(signal),
    get: (_target, _id, signal) => read(signal),
  }, undefined, {
    inspect: (_target, signal) => read(signal),
    plan: (_target, _id, signal) => read(signal),
  })
  const target = (await request('POST', '/api/targets', { backends: ['dtach'], name: 'Cancel', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev' })).json()
  await app.listen({ host: '127.0.0.1', port: 0 })
  const controller = new AbortController()
  const paths = { directories: '/directories?path=/', sessions: '/sessions', connect: '/sessions/session/connect', software: '/software', script: '/software/dtach/script' }
  const pending = fetch(`http://127.0.0.1:${app.server.address().port}/api/targets/${target.id}${paths[operation]}`, {
    method: operation === 'connect' ? 'POST' : 'GET', headers, signal: controller.signal,
  })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  assert.ok(await didStart, 'the read receives its request signal')
  controller.abort()
  await rejected
  await didCancel
})

test('failed software checks are retryable; all session operations use the target service', async t => {
  let attempts = 0
  const session = { id: 'session', name: 'Feature', rootDir: '/root/project', status: 'idle' }
  const { request } = await fixture(t, {
    list: async () => ({ sessions: [session], registryPath: '/root/.outpost/sessions.json' }),
    create: async (_, input) => ({ ...session, ...input }),
    remove: async () => { throw new AppError('Exit the coding tool first', 409) },
  }, undefined, { inspect: async () => { if (++attempts === 1) throw new AppError('SSH authentication failed', 502); return report } })
  const target = (await request('POST', '/api/targets', { backends: ['dtach'], name: 'Dev', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev' })).json()
  const base = `/api/targets/${target.id}`
  assert.equal((await request('GET', `${base}/software`)).statusCode, 502)
  assert.equal((await request('GET', '/api/targets')).json().length, 1)
  assert.equal((await request('GET', `${base}/software`)).statusCode, 200)
  assert.equal((await request('GET', `${base}/sessions`)).json().sessions[0].name, 'Feature')
  assert.equal((await request('POST', `${base}/sessions`, { backend: 'dtach', tool: 'codex', name: 'Feature', rootDir: "~/my project's files" })).statusCode, 201)
  assert.equal((await request('POST', `${base}/sessions`, { backend: 'dtach', tool: 'codex', name: 'x', rootDir: 'relative' })).statusCode, 400)
  assert.equal((await request('DELETE', `${base}/sessions/session`)).statusCode, 409)
})

test('connection scripts verify signatures and expiry, reopen the terminal, and survive manager restarts', async t => {
  const { request, store } = await fixture(t, { get: async () => ({ id: 'session' }) })
  const target = (await request('POST', '/api/targets', { backends: ['dtach'], name: 'Dev', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev-alias', identityFile: "/tmp/key with 'quote", port: 2222 })).json()
  const connection = (await request('POST', `/api/targets/${target.id}/sessions/session/connect`)).json()
  assert.match(connection.commands.bash, /^curl -fsS 'http:\/\/localhost(?::80)?\/api\/connect\/.*' \| bash$/)
  const url = connection.commands.bash.match(/'([^']+)'/)[1]
  const path = new URL(url).pathname
  const response = await request('GET', path)
  assert.equal(response.statusCode, 200)
  assert.match(response.body, /0<>"\$terminal" 1>&0 2>&0/)
  assert.match(response.body, /'ssh'|'dev-alias'/)
  assert.match(response.body, /'-tt'/)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal((await request('GET', `${path}tampered`)).statusCode, 403)
  const psPath = new URL(connection.commands.powershell.match(/'([^']+)'/)[1]).pathname
  const psResponse = await request('GET', psPath)
  assert.equal(psResponse.statusCode, 200)
  assert.match(psResponse.headers['content-type'], /^text\/plain/)
  assert.equal(psResponse.headers['cache-control'], 'no-store')
  assert.ok(connection.commands.cmd.includes(connection.commands.powershell))
  const [psPayload, psSignature] = psPath.split('/').at(-1).split('.')
  const psTicket = JSON.parse(Buffer.from(psPayload, 'base64url').toString())
  assert.equal(psTicket.shell, 'powershell')
  const changedShell = Buffer.from(JSON.stringify({ ...psTicket, shell: 'bash' })).toString('base64url')
  assert.equal((await request('GET', `/api/connect/${changedShell}.${psSignature}`)).statusCode, 403)
  const payload = Buffer.from(JSON.stringify({ targetId: target.id, sessionId: 'session', expires: 0, shell: 'bash' })).toString('base64url')
  const signature = createHmac('sha256', await store.secret()).update(payload).digest('base64url')
  assert.equal((await request('GET', `/api/connect/${payload}.${signature}`)).statusCode, 410)
  const expiredPs = Buffer.from(JSON.stringify({ ...psTicket, expires: 0 })).toString('base64url')
  assert.equal((await request('GET', `/api/connect/${expiredPs}.${createHmac('sha256', await store.secret()).update(expiredPs).digest('base64url')}`)).statusCode, 410)
  const restarted = await createApp({ store: new TargetStore(store.directory), service: { get: async () => ({ id: 'session' }) } })
  t.after(() => restarted.close())
  assert.equal((await restarted.inject(path)).statusCode, 200)
  await request('DELETE', `/api/targets/${target.id}`)
  assert.equal((await request('GET', path)).statusCode, 404)
})

test('every session list request reads the target anew and never returns a cached fallback', async t => {
  let reads = 0
  const { request } = await fixture(t, {
    list: async () => {
      if (++reads === 3) throw new AppError('Target is unreachable', 502)
      return { sessions: [{ id: `live-${reads}` }], registryPath: '/root/.outpost/sessions.json' }
    },
  })
  const target = (await request('POST', '/api/targets', { backends: ['dtach'], name: 'Live target', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev' })).json()
  const path = `/api/targets/${target.id}/sessions`
  for (const id of ['live-1', 'live-2']) {
    const response = await request('GET', path)
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().sessions[0].id, id)
    assert.equal(response.headers['cache-control'], 'no-store')
  }
  const failed = await request('GET', path)
  assert.equal(failed.statusCode, 502)
  assert.equal(failed.headers['cache-control'], 'no-store')
  assert.deepEqual(failed.json(), { message: 'Target is unreachable' })
  assert.equal(reads, 3)
})

test('signed connection tickets require the complete current payload shape', async t => {
  const { request, store } = await fixture(t)
  const target = (await request('POST', '/api/targets', { kind: 'ssh', name: 'Tickets', host: 'dev', backends: ['tmux'], tools: ['codex'] })).json()
  const secret = await store.secret()
  const ticket = { targetId: target.id, sessionId: 'session', expires: Date.now() + 60_000, shell: 'bash' }
  const missingExpiry = { ...ticket }; delete missingExpiry.expires
  for (const contents of [
    '{', JSON.stringify(missingExpiry), JSON.stringify({ ...ticket, expires: 'later' }),
    JSON.stringify({ ...ticket, expires: null }), JSON.stringify({ ...ticket, sessionId: null }),
    JSON.stringify({ ...ticket, shell: 'cmd' }), JSON.stringify({ ...ticket, extra: true }),
  ]) {
    const payload = Buffer.from(contents).toString('base64url')
    const signature = createHmac('sha256', secret).update(payload).digest('base64url')
    const response = await request('GET', `/api/connect/${payload}.${signature}`)
    assert.equal(response.statusCode, 403, response.body)
  }
})

test('termination targets one target session and preserves its record', async t => {
  const calls = []
  const stopped = { id: 'session-1', name: 'Work', rootDir: '/root/project', status: 'stopped' }
  const { app, request } = await fixture(t, {
    terminate: async (target, id) => {
      calls.push({ targetId: target.id, sessionId: id })
      if (id !== stopped.id) throw new AppError('Session not found', 404)
      return stopped
    },
    list: async () => ({ sessions: [stopped], registryPath: '/root/.outpost/sessions.json' }),
  })
  const target = (await request('POST', '/api/targets', { backends: ['dtach'], name: 'Dev', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev' })).json()
  const base = `/api/targets/${target.id}/sessions`
  const endpoint = `${base}/${stopped.id}/terminate`
  assert.equal((await app.inject({ method: 'POST', url: endpoint })).statusCode, 403)
  assert.equal(calls.length, 0)
  const response = await request('POST', endpoint)
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), stopped)
  assert.deepEqual(calls, [{ targetId: target.id, sessionId: stopped.id }])
  assert.deepEqual((await request('GET', base)).json().sessions, [stopped])
  assert.equal((await request('POST', `${base}/missing/terminate`)).statusCode, 404)
  assert.equal((await request('POST', '/api/targets/missing/sessions/session-1/terminate')).statusCode, 404)
  assert.equal(calls.length, 2, 'unknown target never reaches SSH')
})

test('desktop launch uses a live validated session and rejects browser-supplied commands', async t => {
  const launches = []
  const terminal = { id: 'macos-terminal', os: 'macos', name: 'Terminal', shell: 'bash' }
  const inputs = []
  let available = true
  const { app, request } = await fixture(t, {
    get: async (_remote, id) => {
      if (id !== 'session') throw new AppError('Session not found', 404)
      return { id }
    },
  }, {
    available: async () => ({ os: 'macos', terminals: available ? [terminal] : [], recommendedId: available ? terminal.id : null }),
    launch: async (makeScript, input) => {
      if (!available) throw new AppError('No desktop terminal is available', 409)
      launches.push(makeScript('bash'))
      inputs.push(input)
      return terminal
    },
  })
  const target = (await request('POST', '/api/targets', { backends: ['tmux'], name: 'Desktop', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev' })).json()
  const base = `/api/targets/${target.id}/sessions/session`
  assert.deepEqual((await request('POST', `${base}/connect`)).json().desktop, { os: 'macos', terminals: [terminal], recommendedId: terminal.id })
  assert.equal(launches.length, 0, 'opening the dialog never launches a terminal')
  assert.equal((await app.inject({ method: 'POST', url: `${base}/launch`, payload: {} })).statusCode, 403)
  assert.equal((await request('POST', `${base}/launch`, {}, { origin: 'https://evil.example' })).statusCode, 403)
  assert.equal((await request('POST', `${base}/launch`, { command: 'anything', shell: 'bash' })).statusCode, 400)
  for (const body of [{ terminalId: '/bin/sh' }, { preferences: { linux: 'macos-iterm2' } }, { preferences: { linux: 'linux-xterm', other: 'app' } }, { terminalId: terminal.id, preferences: {} }]) {
    assert.equal((await request('POST', `${base}/launch`, body)).statusCode, 400)
  }
  assert.equal((await request('POST', '/api/targets/missing/sessions/session/launch', {})).statusCode, 404)
  assert.equal((await request('POST', `/api/targets/${target.id}/sessions/missing/launch`, {})).statusCode, 404)
  assert.equal(launches.length, 0)
  const launched = await request('POST', `${base}/launch`, {})
  assert.equal(launched.statusCode, 200, launched.body)
  assert.equal(launched.headers['cache-control'], 'no-store')
  assert.deepEqual(launched.json(), terminal)
  assert.equal(launches.length, 1)
  assert.match(launches[0], /'ssh'.*0<>"\$terminal"/)
  for (const body of [{ terminalId: terminal.id }, { preferences: { macos: 'macos-iterm2', windows: 'windows-terminal', linux: 'linux-xterm' } }]) {
    assert.equal((await request('POST', `${base}/launch`, body)).statusCode, 200)
    assert.deepEqual(inputs.at(-1), body, 'validated terminal choices reach the desktop launcher')
  }
  available = false
  assert.deepEqual((await request('POST', `${base}/connect`)).json().desktop, { os: 'macos', terminals: [], recommendedId: null })
  assert.equal((await request('POST', `${base}/launch`, {})).statusCode, 409)
  assert.equal(launches.length, 3)
})

test('finishing software inspection after target removal never recreates the target', async t => {
  let finishInspection, started
  const didStart = new Promise(resolve => { started = resolve })
  const { request } = await fixture(t, {}, undefined, {
    inspect: async () => { started(); return new Promise(resolve => { finishInspection = resolve }) },
  })
  const target = (await request('POST', '/api/targets', { tools: ['codex', 'kimi', 'claude'], kind: 'ssh', name: 'Being removed', host: 'dev', backends: ['tmux'] })).json()
  const pending = request('GET', `/api/targets/${target.id}/software`)
  // inject is lazy until awaited or observed.
  const completion = pending.then(response => response)
  await didStart
  assert.equal((await request('DELETE', `/api/targets/${target.id}`)).statusCode, 204)
  finishInspection(report)
  assert.equal((await completion).statusCode, 404)
  assert.deepEqual((await request('GET', '/api/targets')).json(), [])
})

test('software checks are live, save only the execution environment, and never install; tool selection is explicit', async t => {
  let checks = 0, installs = 0
  const { request, directory } = await fixture(t, { create: async (_target, input) => input }, undefined, {
    inspect: async target => ({ ...report, software: target.tools.map(id => ({ id, status: 'installed', path: `/bin/${id}`, version: `version ${++checks}`, detail: null })) }),
    install: async () => { installs++; return 0 },
  })
  for (const tools of [undefined, [], ['codex', 'codex'], ['unknown']]) {
    assert.equal((await request('POST', '/api/targets', { kind: 'ssh', name: 'Invalid', host: 'dev', backends: ['tmux'], tools })).statusCode, 400)
  }
  const added = (await request('POST', '/api/targets', { kind: 'ssh', name: 'software', host: 'dev', backends: ['tmux'], tools: ['kimi'] })).json()
  assert.equal(checks, 0, 'saving an instance does not contact its host')
  const base = `/api/targets/${added.id}`
  for (const version of ['version 1', 'version 2']) {
    const response = await request('GET', `${base}/software`)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.json().software[0].version, version)
  }
  const config = JSON.parse(await readFile(join(directory, 'targets.json'), 'utf8'))
  assert.deepEqual(config.targets[0].environment, environment)
  assert.equal(config.targets[0].software, undefined)
  assert.equal(installs, 0)
  assert.equal((await request('POST', `${base}/sessions`, { backend: 'tmux', name: 'unselected', rootDir: '/root', tool: 'codex' })).statusCode, 400)
  assert.equal((await request('PATCH', `${base}/requirements`, { backends: ['tmux'], tools: [] })).statusCode, 400)
  assert.equal((await request('PATCH', `${base}/requirements`, { backends: ['tmux'], tools: ['codex', 'kimi'] })).statusCode, 200)
  assert.equal((await request('POST', `${base}/sessions`, { backend: 'tmux', name: 'selected', rootDir: '/root', tool: 'codex' })).statusCode, 201)
})

test('installation runs the submitted script, streams before completion, survives viewers closing, and replays bounded logs', { timeout: 10_000 }, async t => {
  let finish, submitted, installSignal
  const done = new Promise(resolve => { finish = resolve })
  const { request, app } = await fixture(t, {}, undefined, {
    inspect: async () => report,
    install: async (_target, script, output, signal) => {
      submitted = script
      installSignal = signal
      output('first live output é\n')
      await done
      output('late stderr and stdout\n')
      return 7
    },
  })
  t.after(() => finish())
  const target = (await request('POST', '/api/targets', { kind: 'ssh', name: 'Install', host: 'dev', backends: ['dtach'], tools: ['codex'] })).json()
  const base = `/api/targets/${target.id}`
  assert.equal((await request('POST', `${base}/installations`, { softwareId: 'dtach', script: 'echo changed' })).statusCode, 409)
  await request('GET', `${base}/software`)
  for (const body of [{ softwareId: 'tmux', script: 'echo x' }, { softwareId: 'codex', script: '\0' }, { softwareId: 'codex', script: '' }, { softwareId: 'codex', script: 'x'.repeat(65537) }]) {
    assert.equal((await request('POST', `${base}/installations`, body)).statusCode, 400)
  }
  const response = await request('POST', `${base}/installations`, { softwareId: 'dtach', script: "printf 'my edited script'\nexit 7\n" })
  assert.equal(response.statusCode, 202)
  const job = response.json()
  await app.listen({ host: '127.0.0.1', port: 0 })
  const origin = `http://127.0.0.1:${app.server.address().port}`
  const controller = new AbortController()
  const eventsPath = `${base}/installations/${job.id}/events`
  const stream = await fetch(`${origin}${eventsPath}`, { signal: controller.signal })
  assert.match(stream.headers.get('content-type'), /application\/x-ndjson/)
  const reader = stream.body.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  assert.match(first, /first live output é/)
  assert.equal((await request('GET', `${base}/installations`)).json().installation.status, 'running')
  assert.equal(submitted, "printf 'my edited script'\nexit 7\n")
  controller.abort()
  assert.equal(installSignal.aborted, false, 'closing the viewer does not cancel the installation')
  assert.equal((await request('POST', `${base}/installations`, { softwareId: 'dtach', script: 'echo duplicate' })).statusCode, 409)
  assert.equal((await request('DELETE', base)).statusCode, 409)
  finish()
  const replay = await (await fetch(`${origin}${eventsPath}`)).text()
  const events = replay.trim().split('\n').map(JSON.parse)
  assert.match(events.filter(event => event.type === 'output').map(event => event.text).join(''), /first live output é[\s\S]*late stderr/)
  const complete = events.find(event => event.type === 'complete').installation
  assert.equal(complete.status, 'failed')
  assert.equal(complete.exitCode, 7)
  assert.ok(complete.finishedAt)
  assert.equal((await request('GET', '/api/targets/missing/installations')).statusCode, 404)
  assert.equal((await request('GET', `${base}/installations/missing/events`)).statusCode, 404)
})

test('manager shutdown cancels an installation before waiting for its open log stream', { timeout: 5000 }, async t => {
  let started, stopped
  const running = new Promise(resolve => { started = resolve })
  const aborted = new Promise(resolve => { stopped = resolve })
  const { request, app } = await fixture(t, {}, undefined, {
    inspect: async () => report,
    install: async (_target, _script, output, signal) => {
      output('installation started\n')
      started()
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      stopped()
      throw new Error('Manager stopped')
    },
  })
  const target = (await request('POST', '/api/targets', { kind: 'ssh', name: 'shutdown', host: 'dev', backends: ['tmux'], tools: ['codex'] })).json()
  const base = `/api/targets/${target.id}`
  await request('GET', `${base}/software`)
  const job = (await request('POST', `${base}/installations`, { softwareId: 'tmux', script: 'script' })).json()
  await running
  await app.listen({ host: '127.0.0.1', port: 0 })
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}${base}/installations/${job.id}/events`)
  const body = response.text()
  await app.close()
  await aborted
  assert.match(await body, /Manager stopped/)
})

test('target removal and installation startup cannot both succeed concurrently', { timeout: 5000 }, async t => {
  let releaseDeletion, enteredDeletion, finishInstallation, enteredInstallation
  const pausedDeletion = new Promise(resolve => { releaseDeletion = resolve })
  const deleting = new Promise(resolve => { enteredDeletion = resolve })
  const installed = new Promise(resolve => { finishInstallation = resolve })
  const installing = new Promise(resolve => { enteredInstallation = resolve })
  const { request, store, app } = await fixture(t, {}, undefined, {
    inspect: async () => report,
    install: async () => { await installed; return 0 },
  })
  app.addHook('preHandler', async request => {
    if (request.method === 'POST' && request.url.endsWith('/installations')) enteredInstallation()
  })
  const target = (await request('POST', '/api/targets', { kind: 'ssh', name: 'Concurrent removal', host: 'dev', backends: ['tmux'], tools: ['codex'] })).json()
  const base = `/api/targets/${target.id}`
  await request('GET', `${base}/software`)
  const snapshot = await store.get(target.id)
  const remove = store.remove.bind(store), get = store.get.bind(store)
  let waiting = false
  store.remove = async id => {
    waiting = true
    enteredDeletion()
    await pausedDeletion
    waiting = false
    return remove(id)
  }
  // Model a read which returns the target while its removal is still pending.
  store.get = async id => waiting ? snapshot : get(id)
  const deletion = request('DELETE', base).then(response => response)
  await deleting
  const installation = request('POST', `${base}/installations`, { softwareId: 'tmux', script: 'install' }).then(response => response)
  try {
    await installing
    await new Promise(resolve => setImmediate(resolve))
    releaseDeletion()
    const [removed, started] = await Promise.all([deletion, installation])
    assert.equal(removed.statusCode, 204, removed.body)
    assert.equal(started.statusCode, 404, 'an installer cannot start using a target that is being removed')
  } finally {
    releaseDeletion()
    finishInstallation()
  }
})
