import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, cp, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const project = fileURLToPath(new URL('../', import.meta.url))
async function deployment(t, mode, production = true) {
  const root = await mkdtemp(join(tmpdir(), 'outpost-production-'))
  const release = join(root, 'release')
  await mkdir(release)
  await cp(join(project, 'dist'), join(release, 'dist'), { recursive: true })
  await copyFile(join(project, 'package.json'), join(release, 'package.json'))
  await symlink(join(project, 'node_modules'), join(release, 'node_modules'), 'junction')
  const state = join(root, 'state')
  const env = {
    ...process.env, NODE_ENV: production ? 'production' : 'development',
    PORT: '0', HOST: '127.0.0.1', OUTPOST_DATA_DIR: state,
    PUBLIC_APP_URL: 'http://127.0.0.1', OUTPOST_TRUST_PROXY: '',
    ENGAGE_LAB_USERNAME: '', ENGAGE_LAB_API_KEY: '', ENGAGE_LAB_FROM_EMAIL: '',
  }
  delete env.OUTPOST_MODE
  if (mode !== undefined) env.OUTPOST_MODE = mode
  const child = spawn(process.execPath, [join(release, 'dist/server/server.js')], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const completion = once(child, 'close')
  t.after(async () => { child.kill('SIGTERM'); await completion; await rm(root, { recursive: true, force: true }) })
  const deadline = Date.now() + 10_000
  while (!/^Server listening at (http:\/\/[^\s]+)$/m.test(output) && Date.now() < deadline) await delay(50)
  const address = output.match(/^Server listening at (http:\/\/[^\s]+)$/m)?.[1]
  assert.ok(address, output)
  assert.match(output, new RegExp(`Outpost deployment mode: ${mode ?? 'local'}`))
  return { address, state }
}

for (const mode of [undefined, 'local']) test(`relocated production bundle in ${mode ?? 'default'} mode serves a personal workspace without accounts or source files`, { timeout: 20_000 }, async t => {
  const { address, state } = await deployment(t, mode)
  assert.deepEqual(await (await fetch(`${address}/health`)).json(), { status: 'ok' })
  assert.deepEqual(await (await fetch(`${address}/api/auth/session`)).json(), { mode: 'local', user: null })
  assert.deepEqual(await (await fetch(`${address}/api/targets`)).json(), [])
  for (const [path, method] of [['/api/auth/signup', 'POST'], ['/api/account/ssh-key', 'GET']]) {
    assert.equal((await fetch(`${address}${path}`, { method, headers: { 'x-outpost-request': '1' } })).status, 404)
  }
  const created = await fetch(`${address}/api/targets`, {
    method: 'POST', headers: { 'x-outpost-request': '1', 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(process.platform === 'win32' ? { kind: 'ssh', host: 'dev.example.invalid' } : { kind: 'local' }),
      name: 'Personal target', tools: ['codex'], backends: ['tmux'],
    }),
  })
  assert.equal(created.status, 201, await created.text())
  assert.equal((await (await fetch(`${address}/api/targets`)).json())[0].name, 'Personal target')
  assert.equal((await readdir(state)).some(name => name.startsWith('accounts.sqlite') || name === 'users'), false)
  const html = await (await fetch(address)).text()
  assert.match(html, /Outpost/)
  assert.match(html, /rel="icon"[^>]+href="\/outpost\.svg"/)
  const logo = await fetch(`${address}/outpost.svg`)
  assert.equal(logo.status, 200)
  assert.match(logo.headers.get('content-type'), /image\/svg\+xml/)
  assert.match(await logo.text(), /<svg[^>]+viewBox="0 0 512 512"/)
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"\s]+)"/g)].map(match => match[1])
  assert.ok(assets.length >= 2)
  for (const path of assets) assert.equal((await fetch(`${address}${path}`)).status, 200)
  for (const path of ['/api/missing', '/server/target.py', '/server/server.js.map']) assert.equal((await fetch(`${address}${path}`)).status, 404)
})

test('explicit hosted startup enables accounts and protects workspaces without falling back to local mode', { timeout: 20_000 }, async t => {
  const { address, state } = await deployment(t, 'hosted', false)
  assert.deepEqual(await (await fetch(`${address}/api/auth/session`)).json(), { mode: 'hosted', user: null })
  for (const path of ['/api/targets', '/api/environment', '/api/account/ssh-key']) assert.equal((await fetch(`${address}${path}`)).status, 401)
  const signup = await fetch(`${address}/api/auth/signup`, {
    method: 'POST', headers: { 'x-outpost-request': '1', 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(signup.status, 400)
  assert.ok((await readdir(state)).includes('accounts.sqlite'))
})
