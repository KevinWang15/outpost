import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createApp } from '../backend/app.ts'
import { TargetStore } from '../backend/store.ts'
import { connectScript, SessionClient } from '../backend/sessions.ts'
import { quote } from '../backend/shell.ts'
import { SoftwareClient } from '../backend/software.ts'

const execute = promisify(execFile)
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))

test('native local lifecycle: both backends, all tools, live state, persistence, and isolated termination without SSH', { timeout: 180_000 }, async t => {
  assert.ok(['linux', 'darwin'].includes(process.platform))
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'outpost-local-')))
  const home = join(directory, "home with 'quotes é")
  const bin = join(home, 'bin')
  await mkdir(bin, { recursive: true })
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, OUTPOST_SESSION_INHERITED: 'inherited', OUTPOST_SESSION_OVERRIDE: 'original' }
  const service = new SessionClient(env)
  const software = new SoftwareClient(env)
  const store = new TargetStore(join(directory, 'manager'))
  let app = await createApp({ store, service, software, desktop: { available: async () => ({ os: 'linux', terminals: [], recommendedId: null }) } })
  const targets = []
  t.after(async () => {
    for (const target of targets) {
      for (const session of (await service.list(target).catch(() => ({ sessions: [] }))).sessions) {
        await service.terminate(target, session.id).catch(() => {})
      }
    }
    await app.close()
    await rm(directory, { recursive: true, force: true })
  })
  // Startup files only exist in this disposable home, never the user's home.
  for (const name of ['.bash_profile', '.zprofile']) await writeFile(join(home, name), `export PATH=${quote(bin)}:"$PATH"\n`)
  await writeFile(join(home, '.hushlogin'), '')
  const sshCapture = join(directory, 'ssh-used')
  await writeFile(join(bin, 'ssh'), `#!/bin/sh\ntouch ${quote(sshCapture)}\nexit 97\n`, { mode: 0o700 })
  const source = await readFile(join(fixtures, 'coding-tool-fixture.py'), 'utf8')
  for (const tool of ['codex', 'kimi', 'claude']) await writeFile(join(bin, tool), source, { mode: 0o700 })
  const request = async (method, path, payload, expected = 200) => {
    const response = await app.inject({ method, url: `/api${path}`, payload, headers: { 'x-outpost-request': '1', host: `127.0.0.1:${app.server.address().port}` } })
    assert.equal(response.statusCode, expected, response.body)
    assert.equal(response.headers['cache-control'], 'no-store')
    return expected === 204 ? undefined : response.json()
  }
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = app.server.address().port
  const records = []
  const heartbeat = async (root, after = 0) => {
    for (let i = 0; i < 50; i++) {
      try {
        const current = JSON.parse(await readFile(join(root, 'heartbeat.json'), 'utf8'))
        if (current.time > after) return current
      } catch { /* The coding tool has not written its first heartbeat yet. */ }
      await delay(50)
    }
    throw new Error(`No heartbeat: ${root}`)
  }
  const terminal = async (file, mode = 'detach', readyFile) => execute('python3', [join(fixtures, 'terminal.py'), file, mode, ...(readyFile ? [readyFile] : [])], { env, timeout: 30_000 })
  const running = async pid => {
    try { return !(await execute('ps', ['-p', String(pid), '-o', 'stat='])).stdout.trim().startsWith('Z') } catch { return false }
  }
  for (const backend of ['tmux', 'dtach']) {
    const added = await request('POST', '/targets', { tools: ['codex', 'kimi', 'claude'], kind: 'local', name: `Local ${backend}`, backends: [backend] }, 201)
    const base = `/targets/${added.id}`
    const { environment } = await request('GET', `${base}/software`)
    const target = { ...added, environment }
    assert.equal(target.environment.home, home, 'never accesses the real home or switches to root')
    assert.equal(target.environment.uid, process.getuid())
    assert.equal(target.environment.platform, process.platform)
    assert.equal(target.host, undefined)
    targets.push(target)
    for (const tool of ['codex', 'kimi', 'claude']) {
      const root = join(home, `${backend}-${tool} project's $(literal) & é`)
      const launchEnv = { OUTPOST_SESSION_MESSAGE: `${backend}-${tool}: 'quotes' $HOME $(touch OUTPOST_ENV_INJECTED)\nsecond line é`, OUTPOST_SESSION_EMPTY: '', OUTPOST_SESSION_OVERRIDE: 'overridden' }
      const args = '--label "two words" --literal \'$(touch OUTPOST_ARGS_INJECTED)\' --message "$OUTPOST_SESSION_MESSAGE" --empty "" "$(printf expanded)"'
      const expectedArgs = ['--label', 'two words', '--literal', '$(touch OUTPOST_ARGS_INJECTED)', '--message', launchEnv.OUTPOST_SESSION_MESSAGE, '--empty', '', 'expanded']
      const session = await request('POST', `${base}/sessions`, { backend, name: tool, tool, rootDir: root, createDirectory: true, env: launchEnv, args }, 201)
      assert.deepEqual(session.env, launchEnv)
      assert.equal(session.args, args)
      await writeFile(join(root, 'capture-input'), '')
      const suggestions = await request('GET', `${base}/directories?path=${encodeURIComponent(join(home, `${backend}-${tool}`))}`)
      assert.deepEqual(suggestions.directories, [root + '/'])
      const command = await request('POST', `${base}/sessions/${session.id}/connect`)
      assert.deepEqual(Object.keys(command.commands), ['bash'])
      const url = new URL(command.commands.bash.match(/'([^']+)'/)[1])
      const file = join(directory, `${backend}-${tool}.sh`)
      await writeFile(file, `curl -fsS ${quote(url.toString())} | bash\n`)
      await terminal(file, 'close')
      const first = await heartbeat(root)
      assert.equal(first.tool, tool)
      assert.equal(first.cliSessionId, session.cliSessionId, 'the actual coding process uses its saved native ID')
      assert.equal(first.cwd, root)
      assert.deepEqual(first.args, expectedArgs)
      assert.deepEqual(first.env, { ...launchEnv, OUTPOST_SESSION_INHERITED: 'inherited' })
      for (const name of ['OUTPOST_ENV_INJECTED', 'OUTPOST_ARGS_INJECTED']) await assert.rejects(readFile(join(root, name)), { code: 'ENOENT' })
      assert.ok((await heartbeat(root, first.time)).time > first.time)
      await terminal(file)
      assert.equal((await heartbeat(root)).pid, first.pid, 'reconnect preserves the process')
      await terminal(file, 'reconnect')
      assert.equal((await heartbeat(root)).pid, first.pid, 'Enter reconnects repeatedly in the same terminal')
      records.push({ target, session, file, root, pid: first.pid, expectedArgs, expectedEnv: first.env })
    }
    const list = await request('GET', `${base}/sessions`)
    assert.equal(list.sessions.length, records.length)
    assert.equal(list.sessions.filter(session => session.backend === backend).length, 3)
    await request('POST', `${base}/sessions`, { backend, name: 'Invalid arguments', tool: 'codex', rootDir: home, args: '--name "unfinished' }, 400)
    assert.equal((await request('GET', `${base}/sessions`)).sessions.length, records.length, 'invalid shell syntax never creates a session')
    const before = await readFile(join(target.environment.home, '.outpost/sessions.json'), 'utf8')
    await request('GET', `${base}/software`)
    assert.equal(await readFile(join(target.environment.home, '.outpost/sessions.json'), 'utf8'), before, 'software checks preserve all records')
  }
  assert.equal(JSON.parse(await readFile(join(targets[0].environment.home, '.outpost/sessions.json'), 'utf8')).sessions.length, 6)
  await t.test('images retain their bytes, paste only into live tmux panes without submitting, and never start idle sessions', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=', 'base64')
    const bytes = Buffer.concat([png, Buffer.alloc(200 * 1024, 42)])
    const image = { data: bytes.toString('base64'), mediaType: 'image/png' }
    for (const record of records) {
      const uploaded = await request('POST', `/targets/${record.target.id}/sessions/${record.session.id}/image`, image)
      assert.deepEqual(await readFile(uploaded.path), bytes, 'large image bytes are transported through stdin')
      assert.equal((await stat(uploaded.path)).mode & 0o777, 0o600)
      assert.equal(uploaded.reference, uploaded.path)
      assert.equal(uploaded.injected, record.session.backend === 'tmux')
      if (uploaded.injected) {
        let input = ''
        for (let i = 0; i < 50 && !input.includes(uploaded.reference); i++) {
          await delay(20)
          input = await readFile(join(record.root, 'input.bin'), 'utf8').catch(() => '')
        }
        assert.equal(input, `\x1b[200~${uploaded.reference}\x1b[201~`, 'one bracketed paste with no newline or Enter')
      } else await assert.rejects(readFile(join(record.root, 'input.bin')), { code: 'ENOENT' })
    }
    const target = targets[0]
    const idle = await service.create(target, { backend: 'tmux', tool: 'codex', name: 'Idle image receiver', rootDir: home })
    const directory = join(home, '.outpost/clipboard', idle.id)
    let first, last
    for (let i = 0; i < 22; i++) {
      last = await service.pasteImage(target, idle.id, { data: png.toString('base64'), mediaType: 'image/png' })
      first ??= last
      assert.equal(last.injected, false)
    }
    assert.equal((await readdir(directory)).length, 20)
    await assert.rejects(readFile(first.path), { code: 'ENOENT' })
    assert.deepEqual(await readFile(last.path), png)
    assert.equal((await service.get(target, idle.id)).status, 'idle')
    const before = await readdir(join(home, '.outpost/clipboard'))
    await assert.rejects(service.pasteImage(target, 'missing', image), error => error.statusCode === 404)
    await assert.rejects(service.pasteImage({ ...target, environment: { ...target.environment, uid: target.environment.uid + 1 } }, idle.id, image), error => error.statusCode === 409)
    assert.deepEqual(await readdir(join(home, '.outpost/clipboard')), before)
    await assert.rejects(stat(join(home, '.outpost/inbox')), { code: 'ENOENT' })
    await service.remove(target, idle.id)
  })
  await t.test('OSC 52 copy escapes reach the attached terminal through tmux and dtach', async () => {
    for (const record of [records[0], records[3]]) {
      const output = JSON.parse((await terminal(record.file, 'clipboard')).stdout).output
      assert.ok(output.includes('\x1b]52;') && output.includes('T1VUUE9TVF9DTElQQk9BUkRfVEVTVA=='))
    }
  })
  await t.test('changing backend requirements preserves both backend lists and existing connections', async () => {
    const base = `/targets/${targets[0].id}`
    const file = join(targets[0].environment.home, '.outpost/sessions.json')
    const before = await readFile(file, 'utf8')
    const both = await request('PATCH', `${base}/requirements`, { backends: ['tmux', 'dtach'], tools: targets[0].tools })
    assert.deepEqual(both.backends, ['tmux', 'dtach'])
    const report = await request('GET', `${base}/software`)
    for (const id of ['tmux', 'dtach']) assert.equal(report.software.find(item => item.id === id).status, 'installed')
    targets[0] = await request('PATCH', `${base}/requirements`, { backends: ['dtach'], tools: targets[0].tools })
    assert.equal(await readFile(file, 'utf8'), before, 'configuration changes never rewrite session records')
    await request('POST', `${base}/sessions`, { backend: 'tmux', tool: 'codex', name: 'Unselected backend', rootDir: home }, 400)
    assert.equal((await request('GET', `${base}/sessions`)).sessions.length, 6)
    await terminal(records[0].file)
    assert.equal((await heartbeat(records[0].root)).pid, records[0].pid, 'an existing tmux link works after deselecting tmux')
  })
  await t.test('incomplete or corrupt session records are rejected without migration or writes', async () => {
    const file = join(targets[0].environment.home, '.outpost/sessions.json')
    const original = await readFile(file, 'utf8')
    const data = JSON.parse(original)
    const first = data.sessions[0]
    const missingConnection = { ...first }; delete missingConnection.lastConnectedAt
    const missingTool = { ...first }; delete missingTool.tool
    const missingBackend = { ...first }; delete missingBackend.backend
    const missingEnv = { ...first }; delete missingEnv.env
    const missingArgs = { ...first }; delete missingArgs.args
    try {
      for (const invalid of [
        { sessions: [missingConnection] }, { sessions: [missingTool] }, { sessions: [missingBackend] },
        { sessions: [missingEnv] }, { sessions: [missingArgs] },
        { sessions: [{ ...first, env: { 'BAD-NAME': 'value' } }] }, { sessions: [{ ...first, env: { VALID: 1 } }] },
        { sessions: [{ ...first, args: null }] }, { sessions: [{ ...first, args: 'bad\0argument' }] },
        { sessions: [{ ...first, rootDir: 'relative' }] }, { sessions: [{ ...first, id: '../socket' }] },
        { sessions: [{ ...first, name: '' }] }, { sessions: [{ ...first, createdAt: 'yesterday' }] },
        { sessions: [{ ...first, legacy: true }] }, { sessions: [first, first] },
      ]) {
        const contents = JSON.stringify(invalid)
        await writeFile(file, contents)
        await assert.rejects(service.list(targets[0]), /Invalid session registry/)
        await assert.rejects(service.terminate(targets[0], first.id), /Invalid session registry/)
        assert.equal(await readFile(file, 'utf8'), contents)
        assert.equal(await running(records[0].pid), true, 'invalid records never cause signals')
      }
    } finally { await writeFile(file, original) }
  })

  assert.equal(JSON.parse(await readFile(join(store.directory, 'targets.json'), 'utf8')).sessions, undefined)
  // Another manager's live edits are immediately visible; there is no list cache.
  const otherService = new SessionClient(env)
  const external = await otherService.create(targets[0], { backend: 'dtach', name: 'External', tool: 'codex', rootDir: home })
  assert.deepEqual(external.env, {})
  assert.equal(external.args, '')
  assert.ok((await request('GET', `/targets/${targets[0].id}/sessions`)).sessions.some(session => session.id === external.id))
  await otherService.remove(targets[0], external.id)
  assert.equal((await request('GET', `/targets/${targets[0].id}/sessions`)).sessions.length, 6)
  await app.close()
  app = await createApp({ store: new TargetStore(store.directory), service: new SessionClient(env), software: new SoftwareClient(env) })
  await app.listen({ host: '127.0.0.1', port })
  for (const record of [records[0], records[3]]) {
    const { target, session, file, root, pid, expectedArgs, expectedEnv } = record
    await terminal(file)
    assert.equal((await heartbeat(root)).pid, pid, 'manager restart preserves existing signed links and processes')
    const base = `/targets/${target.id}/sessions/${session.id}`
    const otherBase = `/targets/${targets.find(item => item.id !== target.id).id}/sessions/${session.id}`
    const otherConnection = await request('POST', `${otherBase}/connect`)
    const otherFile = join(directory, `other-target-${session.backend}.sh`)
    await writeFile(otherFile, otherConnection.commands.bash)
    await terminal(otherFile)
    assert.equal((await heartbeat(root)).pid, pid, 'same-account targets reconnect through the session’s saved backend')
    await request('POST', `${otherBase}/terminate`)
    assert.equal(await running(pid), false)
    await request('POST', `${base}/terminate`)
    await writeFile(join(root, 'spawn-child'), '')
    await terminal(file)
    const child = Number(await readFile(join(root, 'child.pid'), 'utf8'))
    const restarted = (await heartbeat(root)).pid
    assert.notEqual(restarted, pid)
    assert.equal((await heartbeat(root)).cliSessionId, session.cliSessionId, 'a new process resumes the original conversation')
    assert.deepEqual((await heartbeat(root)).args, expectedArgs)
    assert.deepEqual((await heartbeat(root)).env, expectedEnv, 'restarts reuse the saved environment')
    const ready = join(directory, `${session.backend}.ready`)
    const attached = terminal(file, 'until-disconnected', ready)
    attached.catch(() => {})
    for (let i = 0; i < 100 && !await readFile(ready, 'utf8').catch(() => ''); i++) await delay(50)
    assert.equal(await readFile(ready, 'utf8'), 'ready')
    await request('POST', `${base}/terminate`)
    await attached
    assert.equal(await running(restarted), false)
    assert.equal(await running(child), false, 'TERM-resistant child is killed')
    assert.equal(await running(records[1].pid), true, 'another session is untouched')
    await request('DELETE', base, undefined, 204)
  }
  const saved = await readFile(join(targets[0].environment.home, '.outpost/sessions.json'), 'utf8')
  await request('DELETE', `/targets/${targets[0].id}`, undefined, 204)
  const readded = await request('POST', '/targets', { tools: ['codex', 'kimi', 'claude'], kind: 'local', name: 'Rediscovered', backends: ['tmux'] }, 201)
  await request('GET', `/targets/${readded.id}/software`)
  assert.equal(await readFile(join(targets[0].environment.home, '.outpost/sessions.json'), 'utf8'), saved)
  assert.equal((await request('GET', `/targets/${readded.id}/sessions`)).sessions.length, 4)
  // A connection run with a different home must fail before looking at a registry.
  const wrongHome = join(directory, 'other-user')
  await mkdir(wrongHome)
  const bad = join(directory, 'wrong-home.sh')
  await writeFile(bad, connectScript(targets[0], records[1].session.id, 'bash'))
  await assert.rejects(execute('python3', [join(fixtures, 'terminal.py'), bad, 'detach'], { env: { ...env, HOME: wrongHome }, timeout: 30_000 }), /Run this local connection on the manager computer/)
  await assert.rejects(readFile(sshCapture), { code: 'ENOENT' }, 'no local operation ever invoked SSH')
})
