import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { createApp } from '../backend/app.ts'
import { TargetStore } from '../backend/store.ts'

const execute = promisify(execFile)
const docker = async (...args) => (await execute('docker', args, { timeout: 180_000, maxBuffer: 4_000_000 })).stdout.trim()
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))

test('fresh SSH instance: no automatic installation, bootstrap without Bash/Python, explicit installs, edited scripts, and failed-install recovery', { timeout: 240_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-software-ssh-'))
  let container, app
  t.after(async () => { await app?.close(); if (container) await docker('rm', '-f', container); await rm(directory, { recursive: true, force: true }) })
  await docker('build', '-f', join(fixtures, 'Dockerfile.software'), '-t', 'outpost-software-test:local', fixtures)
  const key = join(directory, 'identity')
  await execute('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', key])
  container = await docker('run', '-d', '--rm', '-p', '127.0.0.1::22', 'outpost-software-test:local')
  await docker('cp', `${key}.pub`, `${container}:/root/.ssh/authorized_keys`)
  await docker('exec', container, 'chown', '0:0', '/root/.ssh/authorized_keys')
  await docker('exec', container, 'chmod', '600', '/root/.ssh/authorized_keys')
  const port = Number((await docker('port', container, '22')).split(':').at(-1))
  app = await createApp({ store: new TargetStore(join(directory, 'manager')) })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const origin = `http://127.0.0.1:${app.server.address().port}`
  const request = async (method, path, body) => {
    const response = await fetch(`${origin}/api${path}`, { method, headers: { 'x-outpost-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, result: await response.json() }
  }
  const added = await request('POST', '/targets', { kind: 'ssh', name: 'Fresh machine', host: '127.0.0.1', port, identityFile: key, backends: ['tmux'], tools: ['codex', 'kimi', 'claude'] })
  assert.equal(added.status, 201)
  const base = `/targets/${added.result.id}`
  const absent = () => docker('exec', container, 'sh', '-c', 'test -e /root/.outpost/sessions.json && echo exists || echo absent')
  const check = async () => {
    const response = await request('GET', `${base}/software`)
    assert.equal(response.status, 200, JSON.stringify(response.result))
    return response.result
  }
  let report = await check()
  for (const id of ['bash', 'python3', 'tmux']) assert.equal(report.software.find(item => item.id === id).status, 'missing')
  assert.equal(await absent(), 'absent')
  assert.equal((await check()).software.find(item => item.id === 'bash').status, 'missing', 'repeated detection never installs')
  const install = async (softwareId, edited) => {
    const preview = await request('GET', `${base}/software/${softwareId}/script`)
    assert.equal(preview.status, 200, JSON.stringify(preview.result))
    assert.equal(await absent(), 'absent')
    const submitted = await request('POST', `${base}/installations`, { softwareId, script: edited ?? preview.result.script })
    assert.equal(submitted.status, 202, JSON.stringify(submitted.result))
    const response = await fetch(`${origin}/api${base}/installations/${submitted.result.id}/events`)
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let text = '', observedBeforeEnd = false
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (text.includes('"type":"output"') && !text.includes('"type":"complete"')) observedBeforeEnd = true
    }
    const events = text.trim().split('\n').map(JSON.parse)
    return { preview: preview.result.script, installation: events.find(event => event.type === 'complete').installation, log: events.filter(event => event.type === 'output').map(event => event.text).join(''), observedBeforeEnd }
  }
  for (const id of ['bash', 'python3', 'tmux']) {
    const result = await install(id)
    assert.equal(result.installation.status, 'succeeded', result.log)
    assert.ok(result.observedBeforeEnd, 'package output streams while the command is running')
    assert.equal((await check()).software.find(item => item.id === id).status, 'installed')
  }
  assert.equal(await docker('exec', container, 'sh', '-c', 'command -v dtach >/dev/null && echo installed || echo absent'), 'absent', 'only the selected backend was installed')
  await docker('exec', container, 'mv', '/usr/local/bin/codex', '/usr/local/bin/codex.fixture')
  assert.equal((await check()).software.find(item => item.id === 'codex').status, 'missing')
  const failed = await install('codex', '#!/bin/sh\nprintf "custom early output é\\n"\nsleep 1\nprintf "failure details\\n" >&2\nexit 17\n')
  assert.equal(failed.installation.status, 'failed')
  assert.equal(failed.installation.exitCode, 17)
  assert.match(failed.log, /custom early output é[\s\S]*failure details/)
  assert.ok(failed.observedBeforeEnd)
  assert.equal((await check()).software.find(item => item.id === 'codex').status, 'missing')
  const installed = await install('codex', '#!/bin/sh\nset -eu\nprintf "restoring fixture\\n"\ncp /usr/local/bin/codex.fixture /usr/local/bin/codex\necho "done"\n')
  assert.match(installed.preview, /https:\/\/chatgpt.com\/codex\/install.sh/)
  assert.equal(installed.installation.status, 'succeeded', installed.log)
  report = await check()
  assert.ok(report.software.every(item => item.status === 'installed'), JSON.stringify(report))
  assert.equal(report.software.find(item => item.id === 'codex').version, 'codex test fixture')
  assert.equal(await absent(), 'absent', 'installations do not initialize the registry')
  assert.deepEqual((await request('GET', `${base}/sessions`)).result.sessions, [])
  assert.equal(await absent(), 'absent', 'empty list is also read-only')
  const session = await request('POST', `${base}/sessions`, { backend: 'tmux', name: 'First session', rootDir: '/root', tool: 'codex' })
  assert.equal(session.status, 201, JSON.stringify(session.result))
  assert.equal(await absent(), 'exists', 'first creation initializes the session registry')
  assert.equal(await docker('exec', container, 'stat', '-c', '%a', '/root/.outpost/sessions.json'), '600')
  // An account with Zsh must inspect and attach using the same login PATH.
  await docker('exec', container, 'apk', 'add', '--no-cache', 'zsh')
  await docker('exec', container, 'sed', '-i', '/^root:/s#:[^:]*$#:/bin/zsh#', '/etc/passwd')
  await docker('exec', container, 'mkdir', '-p', '/root/.kimi-code/bin')
  await docker('exec', container, 'mv', '/usr/local/bin/kimi', '/root/.kimi-code/bin/kimi')
  const profile = join(directory, 'zshrc')
  await writeFile(profile, 'export PATH="$HOME/.kimi-code/bin:$PATH"\n')
  await docker('cp', profile, `${container}:/root/.zshrc`)

  const zsh = await check()
  assert.equal(zsh.environment.shell, '/bin/zsh')
  assert.equal(zsh.software.find(item => item.id === 'kimi').path, '/root/.kimi-code/bin/kimi')
  const kimi = await request('POST', `${base}/sessions`, { backend: 'tmux', name: 'Zsh Kimi', rootDir: '/root/zsh-work', tool: 'kimi', createDirectory: true })
  assert.equal(kimi.status, 201, JSON.stringify(kimi.result))
  const connection = await request('POST', `${base}/sessions/${kimi.result.id}/connect`)
  const command = join(directory, 'zsh.sh')
  await writeFile(command, connection.result.commands.bash + '\n')
  await execute('python3', [join(fixtures, 'terminal.py'), command, 'detach'], { timeout: 30_000 })
  assert.equal(JSON.parse(await docker('exec', container, 'cat', '/root/zsh-work/heartbeat.json')).tool, 'kimi')

})
