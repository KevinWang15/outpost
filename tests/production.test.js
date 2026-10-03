import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const project = fileURLToPath(new URL('../', import.meta.url))
test('relocated production bundle serves the UI and target API without source files or a database', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'outpost-production-'))
  const release = join(root, 'release')
  await mkdir(release)
  await cp(join(project, 'dist'), join(release, 'dist'), { recursive: true })
  await copyFile(join(project, 'package.json'), join(release, 'package.json'))
  await symlink(join(project, 'node_modules'), join(release, 'node_modules'), 'junction')
  const child = spawn(process.execPath, [join(release, 'dist/server/server.js')], {
    cwd: root, env: { ...process.env, PORT: '0', HOST: '127.0.0.1', OUTPOST_DATA_DIR: join(root, 'state') }, stdio: ['ignore', 'pipe', 'pipe'],
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
  assert.deepEqual(await (await fetch(`${address}/health`)).json(), { status: 'ok' })
  assert.deepEqual(await (await fetch(`${address}/api/targets`)).json(), [])
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
