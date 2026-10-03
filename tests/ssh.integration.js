import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createApp } from '../backend/app.ts'
import { TargetStore } from '../backend/store.ts'
import { connectScript } from '../backend/sessions.ts'
import { Accounts } from '../backend/accounts.ts'
import { expectedKeyboardInput, normalizeKeyboardControls } from './fixtures/keyboard.js'

const execute = promisify(execFile)
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
const docker = async (...args) => (await execute('docker', args, { timeout: 300_000, maxBuffer: 4_000_000 })).stdout.trim()

test('hosted accounts connect only with their own SSH key, including when a target names another manager key', { timeout: 360_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'outpost-account-ssh-'))
  let container, app, accounts
  t.after(async () => {
    if (app) await app.close()
    else accounts?.close()
    if (container) await docker('rm', '-f', container)
    await rm(temporary, { recursive: true, force: true })
  })
  accounts = await Accounts.open({ directory: join(temporary, "state with 'quote'"), publicUrl: 'http://127.0.0.1:5173', production: false, mailer: null })
  function member(email) {
    const user = accounts.store.create(email, 'Dev', 'unused test hash')
    const verified = accounts.store.consumeToken(accounts.store.issueToken(user.id, 'verify', 10000), 'verify')
    return { user: verified, cookie: `outpost_session=${accounts.store.issueSession(verified).token}` }
  }
  const alice = member('alice@example.com'), bob = member('bob@example.com')
  await accounts.keys.publicKey(alice.user.id)
  await accounts.keys.publicKey(bob.user.id)
  await docker('build', '-t', 'outpost-ssh-test:local', fixtures)
  container = await docker('run', '-d', '--rm', '-p', '127.0.0.1::22', 'outpost-ssh-test:local')
  await docker('cp', `${accounts.keys.paths(alice.user.id).identityFile}.pub`, `${container}:/root/.ssh/authorized_keys`)
  await docker('exec', container, 'chown', '0:0', '/root/.ssh/authorized_keys')
  await docker('exec', container, 'chmod', '600', '/root/.ssh/authorized_keys')
  const port = Number((await docker('port', container, '22')).split(':').at(-1))
  app = await createApp({ accounts })
  const request = (method, url, payload, cookie) => app.inject({ method, url, payload, headers: { 'x-outpost-request': '1', cookie } })
  const input = { name: 'Server', kind: 'ssh', host: '127.0.0.1', port, backends: ['tmux'], tools: ['codex'], identityFile: accounts.keys.paths(alice.user.id).identityFile }
  const a = (await request('POST', '/api/targets', input, alice.cookie)).json()
  const b = (await request('POST', '/api/targets', input, bob.cookie)).json()
  const success = await request('GET', `/api/targets/${a.id}/software`, undefined, alice.cookie)
  assert.equal(success.statusCode, 200, success.body)
  assert.equal(success.json().environment.username, 'root')
  const denied = await request('GET', `/api/targets/${b.id}/software`, undefined, bob.cookie)
  assert.ok(denied.statusCode >= 400, 'a target cannot borrow another account’s manager SSH identity')
  await docker('cp', `${accounts.keys.paths(bob.user.id).identityFile}.pub`, `${container}:/tmp/bob-key.pub`)
  await docker('exec', container, 'sh', '-c', 'cat /tmp/bob-key.pub >> /root/.ssh/authorized_keys')
  const authorized = await request('GET', `/api/targets/${b.id}/software`, undefined, bob.cookie)
  assert.equal(authorized.statusCode, 200, authorized.body)
})

const shells = process.env.OUTPOST_PWSH ? ['bash', 'powershell'] : ['bash']
for (const shell of shells) for (const backend of ['dtach', 'tmux']) test(`real SSH + ${backend} + ${shell}: software installation, registry, terminal persistence, repaint, and termination`, { timeout: 360_000 }, async t => {
  const extension = shell === 'bash' ? 'sh' : 'ps1'
  const temporary = await mkdtemp(join(tmpdir(), 'outpost-ssh-'))
  let container, app
  t.after(async () => {
    await app?.close()
    if (container) await docker('rm', '-f', container)
    await rm(temporary, { recursive: true, force: true })
  })
  await docker('build', '-t', 'outpost-ssh-test:local', fixtures)
  const key = join(temporary, "identity with 'quote")
  await execute('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', key])
  container = await docker('run', '-d', '--rm', '-p', '127.0.0.1::22', 'outpost-ssh-test:local')
  await docker('cp', `${key}.pub`, `${container}:/root/.ssh/authorized_keys`)
  // docker cp preserves the runner's UID; sshd requires root's key file to be
  // owned by root, including when tests run as a non-root CI user.
  await docker('exec', container, 'chown', '0:0', '/root/.ssh/authorized_keys')
  await docker('exec', container, 'chmod', '600', '/root/.ssh/authorized_keys')
  const port = Number((await docker('port', container, '22')).split(':').at(-1))
  const toolsHash = () => docker('exec', container, 'sha256sum', '/usr/local/bin/codex', '/usr/local/bin/kimi', '/usr/local/bin/claude')
  const beforeHash = await toolsHash()
  const store = new TargetStore(join(temporary, 'manager'))
  app = await createApp({ store })
  await app.listen({ host: '127.0.0.1', port: 0 })
  let address = app.server.address()
  let origin = `http://127.0.0.1:${address.port}`
  const request = async (method, path, body) => {
    const response = await fetch(`${origin}/api${path}`, { method, headers: { 'x-outpost-request': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const result = response.status === 204 ? null : await response.json()
    if (method === 'GET' && path.endsWith('/sessions')) assert.equal(response.status, 200, JSON.stringify(result))
    return { status: response.status, result, headers: response.headers }
  }
  const added = await request('POST', '/targets', { name: 'SSH fixture', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: '127.0.0.1', port, identityFile: key, backends: [backend] })
  assert.equal(added.status, 201)
  const base = `/targets/${added.result.id}`
  await docker('exec', container, 'mv', '/usr/local/bin/codex', '/tmp/outpost-codex-fixture')
  const initial = await request('GET', `${base}/software`)
  assert.equal(initial.status, 200, JSON.stringify(initial.result))
  assert.equal(initial.result.software.find(item => item.id === backend).status, 'missing')
  assert.equal(await docker('exec', container, 'sh', '-c', 'test -e /root/.outpost/sessions.json && echo exists || echo absent'), 'absent', 'adding and checking never initializes the registry')
  const installBackend = async targetBase => {
    const check = await request('GET', `${targetBase}/software`)
    const backendId = check.result.software.find(item => ['tmux', 'dtach'].includes(item.id)).id
    const plan = await request('GET', `${targetBase}/software/${backendId}/script`)
    assert.equal(plan.status, 200, JSON.stringify(plan.result))
    const install = await request('POST', `${targetBase}/installations`, { softwareId: backendId, script: plan.result.script })
    assert.equal(install.status, 202, JSON.stringify(install.result))
    const response = await fetch(`${origin}/api${targetBase}/installations/${install.result.id}/events`)
    const events = (await response.text()).trim().split('\n').map(JSON.parse)
    const final = events.find(event => event.type === 'complete')
    assert.equal(final.installation.status, 'succeeded', events.filter(event => event.type === 'output').map(event => event.text).join(''))
    assert.ok(events.some(event => event.type === 'output'))
    return request('GET', `${targetBase}/software`)
  }
  const installed = await installBackend(base)
  assert.equal(installed.result.software.find(item => item.id === backend).status, 'installed')
  const alternative = backend === 'tmux' ? 'dtach' : 'tmux'
  assert.equal(await docker('exec', container, 'sh', '-c', `command -v ${alternative} >/dev/null && echo present || echo absent`), 'absent', 'explicit installation only installs the selected backend')
  await docker('exec', container, 'python3', '-c', 'from pathlib import Path; Path("/root/.tmux.conf").write_text(\'run-shell "touch /tmp/USER_TMUX_CONFIG_LOADED"\\n\')')
  assert.equal(await docker('exec', container, 'sh', '-c', 'command -v codex >/dev/null && echo present || echo absent'), 'absent', 'installing the backend never installs Codex')
  await docker('exec', container, 'mv', '/tmp/outpost-codex-fixture', '/usr/local/bin/codex')
  assert.equal(await toolsHash(), beforeHash, 'installing the backend never modifies any coding tool')
  const registry = '/root/.outpost/sessions.json'
  await t.test('directory completion reads the target live, treats paths literally, and leaves the registry untouched', async () => {
    await docker('exec', container, 'python3', '-c', [
      'from pathlib import Path',
      'root = Path("/root/completions")',
      'root.mkdir()',
      `names = ${JSON.stringify(['alpha', 'alpine', '.hidden', 'space dir', "quote' $(touch OUTPOST_COMPLETION_INJECTED)", 'a[1]', '中文', 'line\nbreak'])}`,
      'for name in names: (root / name).mkdir()',
      '(root / "file.txt").write_text("fixture")',
      '(root / "dir-link").symlink_to(root / "alpha", target_is_directory=True)',
      '(root / "file-link").symlink_to(root / "file.txt")',
      '(root / "broken-link").symlink_to(root / "missing")',
      'for i in range(60): (root / "many" / ("dir%02d" % i)).mkdir(parents=True)',
    ].join('\n'))
    const lookup = async prefix => {
      const response = await request('GET', `${base}/directories?path=${encodeURIComponent(prefix)}`)
      assert.equal(response.status, 200, JSON.stringify(response.result))
      return response.result
    }
    assert.ok((await lookup('')).directories.includes('~/completions/'))
    assert.ok((await lookup('~')).directories.includes('~/completions/'))
    assert.ok((await lookup('/')).directories.includes('/root/'))
    assert.deepEqual(await lookup('/root/compl'), { directories: ['/root/completions/'], truncated: false })
    assert.deepEqual((await lookup('~/completions/al')).directories, ['~/completions/alpha/', '~/completions/alpine/'])
    assert.deepEqual((await lookup('~/completions/.')).directories, ['~/completions/.hidden/'])
    assert.deepEqual((await lookup('/root/completions/space ')).directories, ['/root/completions/space dir/'])
    assert.deepEqual((await lookup('/root/completions/quote')).directories, ["/root/completions/quote' $(touch OUTPOST_COMPLETION_INJECTED)/"])
    assert.deepEqual((await lookup('/root/completions/a[')).directories, ['/root/completions/a[1]/'])
    assert.deepEqual((await lookup('/root/completions/中')).directories, ['/root/completions/中文/'])
    const children = (await lookup('/root/completions/')).directories
    assert.ok(children.includes('/root/completions/dir-link/'))
    assert.ok(!children.some(path => /file|broken|hidden|\n/.test(path)))
    for (const prefix of ['/root/completions/Alpha', '/root/completions/file.txt/', '/root/completions/missing/']) {
      assert.deepEqual(await lookup(prefix), { directories: [], truncated: false })
    }
    const limited = await lookup('~/completions/many/')
    assert.equal(limited.truncated, true)
    assert.deepEqual(limited.directories, Array.from({ length: 50 }, (_, i) => `~/completions/many/dir${String(i).padStart(2, '0')}/`))
    assert.deepEqual((await lookup('/root/completions/fresh')).directories, [])
    await docker('exec', container, 'mkdir', '/root/completions/fresh')
    assert.deepEqual((await lookup('/root/completions/fresh')).directories, ['/root/completions/fresh/'])
    assert.equal(await docker('exec', container, 'python3', '-c',
      'from pathlib import Path; print(any(p.exists() for p in [Path("/root/OUTPOST_COMPLETION_INJECTED"), Path("/root/.outpost/OUTPOST_COMPLETION_INJECTED"), Path("/root/completions/missing"), Path("/root/.outpost/sessions.json")]))'), 'False')
  })
  await t.test('coding session finder searches files over SSH, links all CLIs by native ID, and never copies history into manager storage', async () => {
    const ids = { codex: randomUUID(), claude: randomUUID(), kimi: 'session_' + randomUUID() }
    const keyword = "SSH_SEARCH_ONLY [.*] 'quote' $(touch /tmp/OUTPOST_SEARCH_INJECTED) 中文"
    await docker('exec', container, 'python3', '-c', [
      'import json, sys', 'from pathlib import Path',
      'ids, keyword = json.loads(sys.argv[1]), sys.argv[2]',
      'def put(path, records):',
      '    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)',
      '    path.write_text("".join(json.dumps(record) + "\\n" for record in records))',
      'put("/root/.codex/sessions/2026/09/30/rollout-finder-" + ids["codex"] + ".jsonl", [{"type": "session_meta", "payload": {"id": ids["codex"], "cwd": "/root"}}, {"type": "response_item", "payload": {"type": "function_call_output", "output": keyword}}])',
      'put("/root/.claude/projects/finder/" + ids["claude"] + ".jsonl", [{"type": "user", "cwd": "/root", "message": {"content": keyword}}])',
      'put("/root/.claude/projects/finder/" + ids["claude"] + "/subagents/agent-fixture.jsonl", [{"type": "assistant", "message": {"content": "SSH_CLAUDE_SUBAGENT_KEYWORD"}}])',
      'kimi = "/root/.kimi-code/sessions/finder/" + ids["kimi"]',
      'put("/root/.kimi-code/session_index.jsonl", [{"sessionId": ids["kimi"], "workDir": "/root"}])',
      'put(kimi + "/state.json", [{"title": "Finder fixture"}])',
      'put(kimi + "/agents/main/wire.jsonl", [{"type": "context.append_message", "message": {"role": "assistant", "content": keyword}}])',
    ].join('\n'), JSON.stringify(ids), keyword)
    assert.equal(await docker('exec', container, 'sh', '-c', `test -e ${registry} && echo exists || echo absent`), 'absent')
    const found = await request('POST', `${base}/coding-sessions/search`, { query: keyword })
    assert.equal(found.status, 200, JSON.stringify(found.result))
    assert.equal(found.headers.get('cache-control'), 'no-store')
    assert.equal(found.result.sessions.length, 3)
    const subagent = await request('POST', `${base}/coding-sessions/search`, { query: 'SSH_CLAUDE_SUBAGENT_KEYWORD', tool: 'claude' })
    assert.equal(subagent.result.sessions[0].cliSessionId, ids.claude)
    for (const match of found.result.sessions) {
      assert.equal(match.cliSessionId, ids[match.tool])
      assert.equal(match.rootDir, '/root')
      assert.equal(match.excerpt, keyword)
      assert.deepEqual(match.managedSessionIds, [])
      const linked = await request('POST', `${base}/sessions`, { backend, tool: match.tool, name: `Finder ${match.tool}`, rootDir: match.rootDir, cliSessionId: match.cliSessionId, cliSessionEnv: match.cliSessionEnv })
      assert.equal(linked.status, 201, JSON.stringify(linked.result))
      assert.equal(linked.result.cliSessionId, match.cliSessionId)
      const refresh = await request('POST', `${base}/coding-sessions/search`, { query: keyword, tool: match.tool })
      assert.deepEqual(refresh.result.sessions[0].managedSessionIds, [linked.result.id])
      assert.equal((await request('DELETE', `${base}/sessions/${linked.result.id}`)).status, 204)
    }
    const before = await docker('exec', container, 'cat', registry)
    assert.equal(before.includes(keyword), false)
    assert.equal((await request('POST', `${base}/coding-sessions/search`, { query: 'SSH_FRESH_WORDS', tool: 'codex' })).result.sessions.length, 0)
    await docker('exec', container, 'python3', '-c', 'import json,sys; from pathlib import Path; path=next(Path("/root/.codex").glob("sessions/**/rollout-finder-" + sys.argv[1] + ".jsonl")); stream=path.open("a"); stream.write(json.dumps({"type":"response_item","payload":{"content":"SSH_FRESH_WORDS"}}) + "\\n"); stream.close()', ids.codex)
    const fresh = await request('POST', `${base}/coding-sessions/search`, { query: 'SSH_FRESH_WORDS', tool: 'codex' })
    assert.equal(fresh.result.sessions[0].cliSessionId, ids.codex, 'each search reads new remote content')
    assert.equal(await docker('exec', container, 'cat', registry), before, 'search never mutates the registry')
    assert.equal(await docker('exec', container, 'sh', '-c', 'test -e /tmp/OUTPOST_SEARCH_INJECTED && echo exists || echo absent'), 'absent')
    assert.equal((await readFile(join(temporary, 'manager/targets.json'), 'utf8')).includes(keyword), false)
  })
  const root = "/root/project with 'quotes; $(touch /tmp/INJECTED)"
  const launchEnv = { OUTPOST_SESSION_MESSAGE: "literal 'quotes' $HOME $(touch /tmp/OUTPOST_ENV_INJECTED)\nsecond é", OUTPOST_SESSION_EMPTY: '' }
  const args = '--label "two words" --literal \'$(touch /tmp/OUTPOST_ARGS_INJECTED)\' --message "$OUTPOST_SESSION_MESSAGE" --empty ""'
  const expectedArgs = ['--label', 'two words', '--literal', '$(touch /tmp/OUTPOST_ARGS_INJECTED)', '--message', launchEnv.OUTPOST_SESSION_MESSAGE, '--empty', '']
  const created = await request('POST', `${base}/sessions`, { backend, tool: 'codex', name: "Feature 'one'", rootDir: root, createDirectory: true, env: launchEnv, args })
  assert.equal(created.status, 201, JSON.stringify(created.result))
  const session = created.result
  assert.equal(session.status, 'idle')
  assert.equal(session.backend, backend)
  assert.equal(session.tool, 'codex')
  assert.equal(session.rootDir, root)
  assert.deepEqual(session.env, launchEnv)
  assert.equal(session.args, args)
  if (backend === 'tmux') await docker('exec', container, 'touch', `${root}/capture-input`, `${root}/keyboard-reset`)
  assert.equal((await request('POST', `${base}/sessions`, { backend, tool: 'codex', name: 'missing', rootDir: '/missing' })).status, 400)
  const concurrent = await Promise.all(Array.from({ length: 6 }, (_, i) => request('POST', `${base}/sessions`, { backend, tool: ['kimi', 'claude', 'codex'][i % 3], name: `parallel-${i}`, rootDir: '/root' })))
  assert.ok(concurrent.every(result => result.status === 201))
  const duplicate = await Promise.all([1, 2].map(() => request('POST', `${base}/sessions`, { backend, tool: 'codex', name: 'duplicate', rootDir: '/root' })))
  assert.deepEqual(duplicate.map(result => result.status).sort(), [201, 409])
  const onRemote = JSON.parse(await docker('exec', container, 'cat', registry))
  assert.equal(onRemote.sessions.length, 8)
  assert.deepEqual([...new Set(onRemote.sessions.map(item => item.tool))].sort(), ['claude', 'codex', 'kimi'])
  assert.equal(await docker('exec', container, 'stat', '-c', '%a', registry), '600')
  const localConfig = JSON.parse(await readFile(join(temporary, 'manager/targets.json'), 'utf8'))
  assert.equal(localConfig.sessions, undefined)
  assert.ok(!JSON.stringify(localConfig).includes(session.id))

  const connection = await request('POST', `${base}/sessions/${session.id}/connect`)
  assert.equal(connection.status, 200)
  const commandFile = join(temporary, `connect.${extension}`)
  await writeFile(commandFile, `${connection.result.commands[shell]}\n`)
  const terminal = async (mode, file = commandFile, readyFile) => {
    const result = await execute('python3', [join(fixtures, 'terminal.py'), file, mode, ...(readyFile ? [readyFile] : [])], { timeout: 30_000, maxBuffer: 1_000_000 })
    return JSON.parse(result.stdout)
  }
  const heartbeat = async () => JSON.parse(await docker('exec', container, 'cat', `${root}/heartbeat.json`))
  await terminal('close')
  const first = await heartbeat()
  assert.equal(first.cliSessionId, session.cliSessionId, 'SSH launches the native coding conversation ID')
  assert.equal(first.tool, 'codex')
  assert.deepEqual(first.args, expectedArgs)
  assert.deepEqual(first.env, launchEnv)
  await delay(700)
  const second = await heartbeat()
  assert.equal(first.pid, second.pid)
  assert.ok(second.time > first.time, 'process continues running while terminal is closed')
  let sessions = (await request('GET', `${base}/sessions`)).result.sessions
  // Closing the local PTY returns before sshd and the backend finish detaching.
  const detachedDeadline = Date.now() + 5_000
  while (sessions.find(item => item.id === session.id).status === 'attached' && Date.now() < detachedDeadline) {
    await delay(100)
    sessions = (await request('GET', `${base}/sessions`)).result.sessions
  }
  assert.equal(sessions.find(item => item.id === session.id).status, 'detached')
  assert.equal((await request('DELETE', `${base}/sessions/${session.id}`)).status, 409)
  await t.test('native AI activity is fetched live through SSH and checking never consumes a newer completion', async () => {
    const append = async type => docker('exec', container, 'python3', '-c',
      "from pathlib import Path; import sys; p=next(Path(sys.argv[1]).glob('sessions/**/rollout-*-' + sys.argv[2] + '.jsonl')); p.open('a').write(sys.argv[3] + '\\n')",
      session.cliSessionEnv.CODEX_HOME, session.cliSessionId, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type, turn_id: 'ssh-fixture' } }))
    const live = async () => (await request('GET', `${base}/sessions`)).result.sessions.find(item => item.id === session.id).activity
    await append('task_started')
    assert.equal((await live()).state, 'working')
    await append('task_complete')
    const firstCompletion = await live()
    assert.equal(firstCompletion.state, 'finished')
    assert.equal((await live()).completionId, firstCompletion.completionId)
    await request('POST', `${base}/sessions/${session.id}/connect`)
    assert.equal((await live()).state, 'finished', 'generating a copy command does not count as reading the answer')
    await append('task_started')
    await append('task_complete')
    const newer = await live()
    assert.notEqual(newer.completionId, firstCompletion.completionId)
    const checked = await request('POST', `${base}/sessions/${session.id}/acknowledge`, { completionId: firstCompletion.completionId })
    assert.equal(checked.status, 200)
    assert.equal(checked.result.activity.state, 'finished')
    assert.equal((await live()).completionId, newer.completionId)
    await terminal('hold')
    assert.equal((await live()).state, 'idle', 'executing the downloaded attachment checks the existing completion')
    assert.equal((await heartbeat()).pid, first.pid)
    const metadata = JSON.parse(await docker('exec', container, 'cat', `/root/.outpost/activity/${session.id}.json`))
    assert.deepEqual(Object.keys(metadata).sort(), ['baseline', 'checked'])
  })
  const beforeReattachSizes = await docker('exec', container, 'cat', `${root}/sizes.log`)
  await terminal('detach')
  assert.equal((await heartbeat()).pid, first.pid, 'reattaching preserves the original process')
  if (backend === 'tmux') await t.test('modified Enter survives the SSH terminal and a late coding-tool startup reset', async () => {
    await terminal('keyboard')
    assert.equal(await docker('exec', container, 'cat', `${root}/keyboard-reset-done`), 'done')
    assert.equal(normalizeKeyboardControls(await docker('exec', container, 'cat', `${root}/input.bin`)), expectedKeyboardInput)
    assert.equal((await heartbeat()).pid, first.pid)
  })
  const clipboard = (await terminal('clipboard')).output
  assert.ok(clipboard.includes('\x1b]52;') && clipboard.includes('T1VUUE9TVF9DTElQQk9BUkRfVEVTVA=='), 'clipboard escapes survive the complete SSH attachment')
  await t.test('large image uploads survive SSH byte-for-byte and use the session backend for injection', async () => {
    const bytes = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=', 'base64'), Buffer.alloc(200 * 1024, 42)])
    const uploaded = await request('POST', `${base}/sessions/${session.id}/image`, { data: bytes.toString('base64'), mediaType: 'image/png' })
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.result))
    assert.equal(await docker('exec', container, 'sha256sum', uploaded.result.path).then(value => value.split(' ')[0]), createHash('sha256').update(bytes).digest('hex'))
    assert.equal(await docker('exec', container, 'stat', '-c', '%a', uploaded.result.path), '600')
    assert.equal(uploaded.result.injected, backend === 'tmux')
    assert.equal(uploaded.result.reference, uploaded.result.path)
    assert.equal((await heartbeat()).pid, first.pid, 'uploading never restarts the coding tool')
  })
  const sizes = (await docker('exec', container, 'cat', `${root}/sizes.log`)).split('\n')
  if (backend === 'dtach') assert.deepEqual(sizes.slice(-2), ['99x30', '100x30'], 'same-size reconnect forces repaint and restores the terminal dimensions')
  else assert.equal(sizes.join('\n'), beforeReattachSizes, 'tmux restores the retained screen without resizing or asking the application to repaint')
  await Promise.all([terminal('hold'), terminal('hold')])
  assert.equal((await heartbeat()).pid, first.pid, 'concurrent attaches do not start duplicate processes')
  assert.equal((await docker('exec', container, 'cat', `${root}/starts.log`)).split('\n').length, 1)
  const saved = createHash('sha256').update(await docker('exec', container, 'cat', registry)).digest('hex')
  assert.equal((await request('GET', `${base}/software`)).status, 200)
  assert.equal(createHash('sha256').update(await docker('exec', container, 'cat', registry)).digest('hex'), saved, 'software checks never change records')
  await app.close()
  app = await createApp({ store: new TargetStore(store.directory) })
  await app.listen({ host: '127.0.0.1', port: address.port })
  address = app.server.address()
  origin = `http://127.0.0.1:${address.port}`
  await terminal('detach')
  assert.equal((await heartbeat()).pid, first.pid, 'downloaded links work across manager restarts')
  const other = concurrent[0].result
  const otherConnection = await request('POST', `${base}/sessions/${other.id}/connect`)
  const otherCommand = join(temporary, `other.${extension}`)
  await writeFile(otherCommand, `${otherConnection.result.commands[shell]}\n`)
  await terminal('detach', otherCommand)
  const otherHeartbeat = async () => JSON.parse(await docker('exec', container, 'cat', '/root/heartbeat.json'))
  const otherPid = (await otherHeartbeat()).pid
  assert.equal((await otherHeartbeat()).tool, 'kimi')
  assert.deepEqual((await otherHeartbeat()).env, {}, 'session variables never leak into another coding tool')
  assert.deepEqual((await otherHeartbeat()).args, [])
  const isRunning = async pid => (await docker('exec', container, 'python3', '-c',
    'import sys; from pathlib import Path; p=Path("/proc", sys.argv[1], "stat"); print(p.exists() and p.read_text().rsplit(")",1)[1].split()[0] not in ("Z", "X"))', String(pid))) === 'True'
  const terminated = await request('POST', `${base}/sessions/${session.id}/terminate`)
  assert.equal(terminated.status, 200, JSON.stringify(terminated.result))
  assert.equal(terminated.result.status, 'stopped')
  assert.equal(terminated.result.id, session.id)
  assert.equal(await isRunning(first.pid), false, 'detached Codex process was terminated')
  assert.equal(await isRunning(otherPid), true, 'another session keeps running')
  assert.equal((await request('POST', `${base}/sessions/${session.id}/terminate`)).status, 200, 'termination is idempotent')
  const idle = await request('POST', `${base}/sessions/${concurrent[1].result.id}/terminate`)
  assert.equal(idle.status, 200)
  assert.equal(idle.result.status, 'idle')
  assert.equal((await request('POST', `${base}/sessions/missing/terminate`)).status, 404)
  await delay(300)
  sessions = (await request('GET', `${base}/sessions`)).result.sessions
  assert.equal(sessions.find(item => item.id === session.id).status, 'stopped')
  // A stale filesystem socket must not prevent reconnecting a stopped session.
  await docker('exec', container, 'python3', '-c', 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()', session.socketPath)
  await docker('exec', container, 'touch', `${root}/spawn-child`)
  await terminal('detach')
  const restartedPid = (await heartbeat()).pid
  assert.equal((await heartbeat()).cliSessionId, session.cliSessionId, 'termination and restart retain the native conversation ID')
  assert.deepEqual((await heartbeat()).args, expectedArgs)
  assert.deepEqual((await heartbeat()).env, launchEnv)
  const childPid = Number(await docker('exec', container, 'cat', `${root}/child.pid`))
  assert.notEqual(restartedPid, first.pid)
  const readyFile = join(temporary, 'attached.ready')
  const attached = terminal('until-disconnected', commandFile, readyFile)
  attached.catch(() => {}) // Report failure below, after the termination request.
  const attachedDeadline = Date.now() + 5_000
  do {
    sessions = (await request('GET', `${base}/sessions`)).result.sessions
    if (sessions.find(item => item.id === session.id).status === 'attached'
      && await readFile(readyFile, 'utf8').catch(() => '') === 'ready') break
    await delay(50)
  } while (Date.now() < attachedDeadline)
  assert.equal(sessions.find(item => item.id === session.id).status, 'attached')
  const attachedTermination = await request('POST', `${base}/sessions/${session.id}/terminate`)
  assert.equal(attachedTermination.status, 200, JSON.stringify(attachedTermination.result))
  assert.equal(attachedTermination.result.status, 'stopped')
  await attached
  assert.equal(await isRunning(restartedPid), false)
  assert.equal(await isRunning(childPid), false, 'TERM-resistant child was forcefully terminated')
  assert.equal(await isRunning(otherPid), true)
  assert.equal((await otherHeartbeat()).pid, otherPid)
  assert.ok(JSON.parse(await docker('exec', container, 'cat', registry)).sessions.some(item => item.id === session.id), 'termination keeps the record')
  assert.equal((await request('DELETE', `${base}/sessions/${session.id}`)).status, 204)
  const injection = await docker('exec', container, 'python3', '-c', 'import os; print(os.path.exists("/tmp/INJECTED"))')
  assert.equal(injection, 'False')
  assert.equal(await docker('exec', container, 'python3', '-c', 'import os; print(any(os.path.exists(p) for p in ["/tmp/OUTPOST_ENV_INJECTED", "/tmp/OUTPOST_ARGS_INJECTED"]))'), 'False')
  assert.equal(await docker('exec', container, 'sh', '-c', 'test -e /tmp/USER_TMUX_CONFIG_LOADED && echo loaded || echo isolated'), 'isolated')
  const beforeForget = await docker('exec', container, 'cat', registry)
  assert.equal((await request('DELETE', base)).status, 204)
  const readded = await request('POST', '/targets', { name: 'Rediscovered', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: '127.0.0.1', port, identityFile: key, backends: [backend] })
  assert.equal((await request('GET', `/targets/${readded.result.id}/software`)).status, 200)
  assert.equal((await request('GET', `/targets/${readded.result.id}/sessions`)).result.sessions.length, 7)
  assert.equal(await docker('exec', container, 'cat', registry), beforeForget)
  assert.equal(await toolsHash(), beforeHash)
  const rediscoveredBase = `/targets/${readded.result.id}`
  const rediscovered = (await request('GET', `${rediscoveredBase}/sessions`)).result.sessions
  assert.ok(rediscovered.every(item => item.backend === backend))
  assert.equal(rediscovered.find(item => item.id === other.id).tool, 'kimi')
  const rediscoveredLink = await request('POST', `${rediscoveredBase}/sessions/${other.id}/connect`)
  await writeFile(otherCommand, `${rediscoveredLink.result.commands[shell]}\n`)
  await terminal('detach', otherCommand)
  assert.equal((await otherHeartbeat()).pid, otherPid, 'rediscovering the target attaches to the existing process')
  await docker('exec', container, 'mv', '/usr/local/bin/codex', '/tmp/outpost-codex-fixture')
  const beforeTwinInstall = await docker('exec', container, 'cat', registry)
  const twin = await request('POST', '/targets', { name: 'Same IP, other backend', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: '127.0.0.1', port, identityFile: key, backends: [alternative] })
  assert.equal(twin.status, 201)
  const twinBase = `/targets/${twin.result.id}`
  assert.equal((await installBackend(twinBase)).status, 200)
  assert.equal((await request('GET', `${twinBase}/sessions`)).result.sessions.length, 7, 'same-host targets show all existing backend records')
  assert.equal(await docker('exec', container, 'cat', registry), beforeTwinInstall)
  const requirements = { backends: [backend, alternative], tools: ['codex', 'kimi', 'claude'] }
  const updated = await request('PATCH', `${rediscoveredBase}/requirements`, requirements)
  assert.equal(updated.status, 200)
  assert.deepEqual(updated.result.backends, [backend, alternative])
  const combinedSoftware = (await request('GET', `${rediscoveredBase}/software`)).result.software
  for (const id of [backend, alternative]) assert.equal(combinedSoftware.find(item => item.id === id).status, 'installed', JSON.stringify(combinedSoftware))
  assert.equal(await docker('exec', container, 'cat', registry), beforeTwinInstall, 'editing requirements does not modify sessions')
  const mixed = await request('POST', `${rediscoveredBase}/sessions`, { backend: alternative, tool: 'claude', name: other.name, rootDir: '/root/mixed', createDirectory: true })
  assert.equal(mixed.status, 201, 'the same session name is allowed on different backends')
  assert.equal(mixed.result.backend, alternative)
  assert.equal((await request('POST', `${twinBase}/sessions`, { backend: alternative, tool: 'codex', name: other.name, rootDir: '/root' })).status, 409, 'names remain unique within one backend')
  const mixedLink = await request('POST', `${twinBase}/sessions/${mixed.result.id}/connect`)
  const mixedCommand = join(temporary, `mixed.${extension}`)
  await writeFile(mixedCommand, `${mixedLink.result.commands[shell]}\n`)
  await terminal('detach', mixedCommand)
  const mixedHeartbeat = async () => JSON.parse(await docker('exec', container, 'cat', '/root/mixed/heartbeat.json'))
  const mixedPid = (await mixedHeartbeat()).pid
  assert.equal((await mixedHeartbeat()).tool, 'claude')
  assert.equal((await mixedHeartbeat()).cliSessionId, mixed.result.cliSessionId)
  await terminal('detach', mixedCommand)
  assert.equal((await mixedHeartbeat()).pid, mixedPid, 'Claude reattaches to the same process')
  const originalList = (await request('GET', `${rediscoveredBase}/sessions`)).result.sessions
  const twinList = (await request('GET', `${twinBase}/sessions`)).result.sessions
  assert.equal(originalList.length, 8)
  assert.deepEqual(twinList.map(item => item.id), originalList.map(item => item.id))
  assert.equal(twinList.find(item => item.id === mixed.result.id).backend, alternative)
  assert.equal(twinList.find(item => item.id === mixed.result.id).tool, 'claude')
  assert.equal(JSON.parse(await docker('exec', container, 'cat', registry)).sessions.length, 8, 'both backends share the complete target registry')
  const beforeChange = await docker('exec', container, 'cat', registry)
  assert.equal((await request('PATCH', `${rediscoveredBase}/requirements`, { ...requirements, backends: [alternative] })).status, 200)
  assert.equal(await docker('exec', container, 'cat', registry), beforeChange)
  assert.equal((await request('GET', `${rediscoveredBase}/sessions`)).result.sessions.length, 8, 'deselected backend sessions stay visible')
  assert.equal((await request('POST', `${rediscoveredBase}/sessions`, { backend, tool: 'kimi', name: 'Unselected backend', rootDir: '/root' })).status, 400)
  const sharedCommand = join(temporary, `shared-backend.${extension}`)
  await writeFile(sharedCommand, connectScript(await store.get(twin.result.id), other.id, shell))
  const rawAttachment = await terminal('detach', sharedCommand)
  if (backend === 'tmux') assert.match(rawAttachment.output, /\[detached/, 'the fast detach shortcut reaches tmux rather than the coding tool')
  assert.equal(await isRunning(otherPid), true, 'direct attachment and detachment preserve the process')
  await terminal('detach', otherCommand)
  assert.equal((await otherHeartbeat()).pid, otherPid, 'existing links and other target entries use the saved backend after deselection')
  assert.equal((await request('POST', `${twinBase}/sessions/${other.id}/connect`)).status, 200)
  assert.equal((await request('DELETE', `${twinBase}/sessions/${other.id}`)).status, 409, 'a running session cannot be deleted from any target entry')
  assert.equal(await isRunning(otherPid), true)
  assert.equal((await request('POST', `${twinBase}/sessions/${other.id}/terminate`)).status, 200)
  assert.equal(await isRunning(otherPid), false)
  assert.equal((await request('GET', `${twinBase}/sessions`)).result.sessions.find(item => item.id === mixed.result.id).status, 'detached', 'terminating one backend leaves the other running')
  assert.equal((await request('POST', `${twinBase}/sessions/${mixed.result.id}/terminate`)).status, 200)
  await terminal('detach', mixedCommand)
  assert.equal((await mixedHeartbeat()).tool, 'claude')
  assert.notEqual((await mixedHeartbeat()).pid, mixedPid, 'restarting retains the chosen tool')
  assert.equal((await mixedHeartbeat()).cliSessionId, mixed.result.cliSessionId, 'Claude resumes its original conversation after restart')
  assert.equal((await request('POST', `${twinBase}/sessions/${mixed.result.id}/terminate`)).status, 200)
  assert.equal((await request('DELETE', `${twinBase}/sessions/${mixed.result.id}`)).status, 204)
  assert.equal((await request('GET', `${twinBase}/sessions`)).result.sessions.length, 7)
  assert.equal((await request('GET', `${rediscoveredBase}/sessions`)).result.sessions.length, 7)
  assert.equal((await request('PATCH', `${rediscoveredBase}/requirements`, requirements)).status, 200)

  // A missing selected tool must give its own error, never silently run another.
  await docker('exec', container, 'mv', '/usr/local/bin/kimi', '/tmp/outpost-kimi-fixture')
  await assert.rejects(terminal('detach', otherCommand), /kimi is not on root's interactive login PATH/)
  await docker('exec', container, 'mv', '/tmp/outpost-kimi-fixture', '/usr/local/bin/kimi')
  await terminal('detach', otherCommand)
  assert.equal((await otherHeartbeat()).tool, 'kimi', 'Kimi starts without Codex installed')
  assert.notEqual((await otherHeartbeat()).pid, otherPid)
  assert.equal((await request('POST', `${rediscoveredBase}/sessions/${other.id}/terminate`)).status, 200)
  await docker('exec', container, 'mv', '/tmp/outpost-codex-fixture', '/usr/local/bin/codex')
  assert.equal(await toolsHash(), beforeHash)

  await t.test('root interactive login PATH finds Kimi and carries its environment into the persistent session', async () => {
    const loginRoot = "/root/login project with 'quotes"
    const kimi = '/root/.kimi-code/bin/kimi'
    const profileFiles = ['/root/.bash_profile', '/root/.bashrc']
    const originalProfiles = await Promise.all(profileFiles.map(async path => {
      const { stdout } = await execute('docker', ['exec', container, 'python3', '-c',
        'from pathlib import Path; import json,sys; p=Path(sys.argv[1]); print(json.dumps(p.read_text() if p.exists() else None))', path])
      return JSON.parse(stdout)
    }))
    try {
      await docker('exec', container, 'mkdir', '-p', '/root/.kimi-code/bin', '/root/.local/bin')
      await docker('exec', container, 'mv', '/usr/local/bin/kimi', kimi)
      await docker('exec', container, 'python3', '-c', [
        'from pathlib import Path',
        `Path("/root/.bash_profile").write_text(${JSON.stringify('export OUTPOST_TEST_LOGIN=from-profile\n. "$HOME/.bashrc"\n')})`,
        `Path("/root/.bashrc").write_text(${JSON.stringify('case $- in *i*) ;; *) return ;; esac\nexport PATH="$HOME/.kimi-code/bin:$PATH"\nexport OUTPOST_TEST_INTERACTIVE=from-bashrc\nprintf "Interactive startup output\\n"\n')})`,
      ].join('\n'))
      assert.equal(await docker('exec', container, 'bash', '-lc', 'command -v kimi || true'), '')
      assert.equal((await docker('exec', container, 'bash', '-lic', 'command -v kimi')).split('\n').at(-1), kimi)
      const software = (await request('GET', `${rediscoveredBase}/software`)).result.software
      assert.equal(software.find(item => item.id === 'kimi').path, kimi, 'detection uses the interactive login PATH')
      assert.equal(software.find(item => item.id === 'kimi').status, 'installed')
      const created = await request('POST', `${rediscoveredBase}/sessions`, {
        backend, tool: 'kimi', name: 'Interactive root environment', rootDir: loginRoot, createDirectory: true,
      })
      assert.equal(created.status, 201, JSON.stringify(created.result))
      const sessionUrl = `${rediscoveredBase}/sessions/${created.result.id}`
      const connection = await request('POST', `${sessionUrl}/connect`)
      assert.equal(connection.status, 200)
      const file = join(temporary, `login-env.${extension}`)
      await writeFile(file, `${connection.result.commands[shell]}\n`)
      await terminal('detach', file)
      const heartbeat = () => docker('exec', container, 'cat', `${loginRoot}/heartbeat.json`).then(JSON.parse)
      const first = await heartbeat()
      assert.equal(first.cliSessionId, created.result.cliSessionId)
      assert.equal(first.tool, 'kimi')
      assert.equal(first.cwd, loginRoot)
      const environment = JSON.parse(await docker('exec', container, 'python3', '-c', [
        'import json,sys',
        'from pathlib import Path',
        'values = dict(entry.split("=", 1) for entry in Path("/proc/" + sys.argv[1] + "/environ").read_bytes().decode().split("\\0") if "=" in entry)',
        'print(json.dumps({key: values.get(key) for key in ["PATH", "OUTPOST_TEST_LOGIN", "OUTPOST_TEST_INTERACTIVE"]}))',
      ].join('\n'), String(first.pid)))
      assert.equal(environment.OUTPOST_TEST_LOGIN, 'from-profile')
      assert.equal(environment.OUTPOST_TEST_INTERACTIVE, 'from-bashrc')
      assert.equal(environment.PATH.split(':')[0], '/root/.kimi-code/bin')
      await terminal('detach', file)
      assert.equal((await heartbeat()).pid, first.pid, 'interactive login preserves same-process reattachment')
      assert.equal((await request('POST', `${sessionUrl}/terminate`)).status, 200)
      // A fallback directory must not override the executable the user selected in PATH.
      await docker('exec', container, 'python3', '-c', [
        'from pathlib import Path',
        `Path("/root/.local/bin/kimi").write_text(${JSON.stringify('#!/bin/sh\necho Wrong Kimi executable >&2\nexit 42\n')})`,
        'Path("/root/.local/bin/kimi").chmod(0o700)',
      ].join('\n'))
      await terminal('detach', file)
      assert.notEqual((await heartbeat()).pid, first.pid, 'restarting resolves the interactive environment again')
      assert.equal((await request('POST', `${sessionUrl}/terminate`)).status, 200)
      assert.equal((await request('DELETE', sessionUrl)).status, 204)
    } finally {
      await docker('exec', container, 'mv', kimi, '/usr/local/bin/kimi')
      await docker('exec', container, 'rm', '-f', '/root/.local/bin/kimi')
      for (const [index, path] of profileFiles.entries()) {
        await docker('exec', container, 'python3', '-c',
          'from pathlib import Path; import json,sys; p=Path(sys.argv[1]); value=json.loads(sys.argv[2]); p.write_text(value) if value is not None else p.unlink()',
          path, JSON.stringify(originalProfiles[index]))
      }
    }
    assert.equal(await toolsHash(), beforeHash)
  })

  if (process.env.OUTPOST_REAL_CODEX_BINARY) {
    await t.test('real Codex repaints on repeated same-size reconnects without restarting', async () => {
      // Only replace the test executable inside this disposable container.
      // No user configuration, credentials, or model requests are involved.
      await docker('cp', process.env.OUTPOST_REAL_CODEX_BINARY, `${container}:/usr/local/lib/outpost-codex`)
      await docker('exec', container, 'python3', '-c',
        'from pathlib import Path; Path("/usr/local/bin/codex").write_text(\'#!/bin/sh\\nexec /usr/local/lib/outpost-codex --no-daemon "$@"\\n\')')
      const realBase = `/targets/${readded.result.id}`
      const realSession = await request('POST', `${realBase}/sessions`, { backend, tool: 'codex', name: 'Real Codex redraw', rootDir: '/root/real-codex', createDirectory: true })
      assert.equal(realSession.status, 201)
      const realConnection = await request('POST', `${realBase}/sessions/${realSession.result.id}/connect`)
      const realCommand = join(temporary, `real-codex.${extension}`)
      await writeFile(realCommand, `${realConnection.result.commands[shell]}\n`)
      const codexPids = () => docker('exec', container, 'python3', '-c', [
        'import os', 'from pathlib import Path', 'pids = []',
        'for p in Path("/proc").iterdir():',
        ' try:',
        '  if p.name.isdigit() and os.readlink(p / "exe") == "/usr/local/lib/outpost-codex": pids.append(p.name)',
        ' except (FileNotFoundError, ProcessLookupError): pass',
        'print(",".join(sorted(pids)))',
      ].join('\n'))
      await terminal('real-codex', realCommand)
      const originalPid = await codexPids()
      assert.match(originalPid, /^\d+$/)
      await terminal('real-codex', realCommand)
      await terminal('real-codex', realCommand)
      assert.equal(await codexPids(), originalPid)
      assert.equal((await request('POST', `${realBase}/sessions/${realSession.result.id}/terminate`)).status, 200)
    })
  }
})
