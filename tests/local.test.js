import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApp } from '../backend/app.ts'
import { LocalTransport } from '../backend/local.ts'
import { TargetStore } from '../backend/store.ts'

const target = { tools: ['codex', 'kimi', 'claude'], kind: 'local', id: 'local', name: 'Local', backends: ['tmux'], createdAt: '2026-09-29T00:00:00Z' }
const environment = { home: '/home/dev', uid: 1000, username: 'dev', shell: '/bin/zsh', platform: 'linux' }

test('local transport bypasses SSH; WSL pins the distribution and user as literal arguments', () => {
  const local = new LocalTransport({ ...target, environment }, 'darwin')
  assert.deepEqual(local.attach('exec tool'), { executable: '/bin/zsh', args: ['-lic', 'exec tool'], label: 'Local shell' })
  const distribution = "Ubuntu Dev's O’Brien $(literal)"
  const wsl = new LocalTransport({ ...target, distribution, environment }, 'win32')
  assert.deepEqual(wsl.attach('exec tool'), { executable: 'wsl.exe', args: ['--distribution', distribution, '--user', 'dev', '--exec', '/bin/zsh', '-lic', 'exec tool'], label: 'WSL' })
  assert.throws(() => new LocalTransport(target, 'win32'), /WSL distribution/)
  assert.throws(() => new LocalTransport(target, 'freebsd'), /Unsupported/)
  assert.throws(() => new LocalTransport(target, 'linux').attach('tool'), /Check Required Software/)
})

test('target API requires explicit kinds and rejects transport-specific fields on the wrong kind', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-target-test-'))
  const store = new TargetStore(directory)
  const scripts = []
  const app = await createApp({ store, software: { inspect: async () => ({ environment, checkedAt: target.createdAt, software: [] }) }, service: { get: async () => ({ id: 'session' }) }, desktop: {
    available: async () => ({ os: 'linux', terminals: [{ id: 'linux-xterm', os: 'linux', name: 'XTerm', shell: 'bash' }], recommendedId: 'linux-xterm' }),
    launch: async makeScript => { scripts.push(makeScript('bash')); return { id: 'linux-xterm', os: 'linux', name: 'XTerm', shell: 'bash' } },
  } })
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }) })
  const request = (method, url, payload) => app.inject({ method, url, payload, headers: { 'x-outpost-request': '1' } })
  for (const input of [
    { name: 'Missing kind', backend: 'tmux', host: 'dev' },
    { name: 'Unknown kind', backend: 'tmux', kind: 'et' },
    { name: 'Local with host', backends: ['tmux'], tools: ['codex', 'kimi', 'claude'], kind: 'local', host: 'dev' },
    { name: 'Local with key', backends: ['tmux'], tools: ['codex', 'kimi', 'claude'], kind: 'local', identityFile: '~/.ssh/id' },
    { name: 'Local with port', backends: ['tmux'], tools: ['codex', 'kimi', 'claude'], kind: 'local', port: 22 },
    { name: 'SSH with distro', backends: ['tmux'], tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev', distribution: 'Ubuntu' },
  ]) assert.equal((await request('POST', '/api/targets', input)).statusCode, 400)
  assert.equal((await request('GET', '/api/environment')).json().platform, process.platform)
  if (process.platform === 'win32') return // WSL may not be installed on this runner.
  assert.equal((await request('POST', '/api/targets', { tools: ['codex', 'kimi', 'claude'], kind: 'local', name: 'WSL on Unix', backends: ['tmux'], distribution: 'Ubuntu' })).statusCode, 400)
  const added = await request('POST', '/api/targets', { tools: ['codex', 'kimi', 'claude'], kind: 'local', name: 'This computer', backends: ['dtach'] })
  assert.equal(added.statusCode, 201, added.body)
  const base = `/api/targets/${added.json().id}`
  await request('GET', `${base}/software`)
  assert.equal((await new TargetStore(directory).get(added.json().id)).kind, 'local')
  const connection = await request('POST', `${base}/sessions/session/connect`)
  assert.deepEqual(Object.keys(connection.json().commands), ['bash'])
  const path = new URL(connection.json().commands.bash.match(/'([^']+)'/)[1]).pathname
  const script = await request('GET', path)
  assert.equal(script.statusCode, 200)
  assert.match(script.body, /exec '\/bin\/zsh'/)
  assert.doesNotMatch(script.body, /exec 'ssh'|OpenSSH/)
  assert.equal((await request('POST', `${base}/sessions/session/launch`, {})).statusCode, 200)
  assert.equal(scripts[0], script.body)
})
