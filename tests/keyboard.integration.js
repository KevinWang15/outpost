import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { SessionClient, connectScript } from '../backend/sessions.ts'
import { quote } from '../backend/shell.ts'
import { expectedKeyboardInput, normalizeKeyboardControls } from './fixtures/keyboard.js'

const execute = promisify(execFile)
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))

test('tmux preserves modified Enter after late startup resets and reconnects without duplicating terminal features', { timeout: 40_000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'outpost-keyboard-')))
  const home = join(directory, "home with 'quotes")
  const bin = join(home, 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(home, '.hushlogin'), '')
  await writeFile(join(home, '.bash_profile'), `export PATH=${quote(bin)}:"$PATH"\n`)
  await writeFile(join(bin, 'codex'), await readFile(join(fixtures, 'coding-tool-fixture.py')), { mode: 0o700 })
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }
  const service = new SessionClient(env)
  const target = { kind: 'local', id: 'keyboard', name: 'Keyboard', backends: ['tmux'], tools: ['codex'], createdAt: '2026-09-30T00:00:00Z', environment: { home, uid: process.getuid(), username: 'fixture', platform: process.platform, shell: '/bin/bash' } }
  const sessions = []
  t.after(async () => {
    for (const session of sessions) await service.terminate(target, session.id).catch(() => {})
    await rm(directory, { recursive: true, force: true })
  })
  const create = async name => {
    const root = join(home, name)
    const session = await service.create(target, { name, backend: 'tmux', tool: 'codex', rootDir: root, createDirectory: true })
    sessions.push(session)
    await writeFile(join(root, 'capture-input'), '')
    await writeFile(join(root, 'keyboard-reset'), '')
    const file = join(directory, `${name}.sh`)
    await writeFile(file, connectScript(target, session.id, 'bash'))
    return { root, session, file }
  }
  const terminal = (file, mode, probe = 1) => execute('python3', [join(fixtures, 'terminal.py'), file, mode], { env: { ...env, OUTPOST_KEYBOARD_PROBE: String(probe) }, timeout: 15_000 })
  const record = await create('Key receiver')
  let firstPid, features
  for (let visit = 0; visit < 3; visit++) {
    await terminal(record.file, 'keyboard', visit + 1)
    assert.equal(await readFile(join(record.root, 'keyboard-reset-done'), 'utf8'), 'done')
    assert.equal(normalizeKeyboardControls(await readFile(join(record.root, 'input.bin'), 'utf8')), expectedKeyboardInput.repeat(visit + 1), 'both modified Enter encodings reach the pane as CSI u; Enter and control keys keep their meaning')
    const pid = JSON.parse(await readFile(join(record.root, 'heartbeat.json'), 'utf8')).pid
    firstPid ??= pid
    assert.equal(pid, firstPid, 'reconnect keeps the original coding process')
    const current = (await execute('tmux', ['-S', join('sockets', `${record.session.id}.sock`), 'show-options', '-gqv', 'terminal-features'], { env, cwd: join(home, '.outpost') })).stdout
    features ??= current
    assert.equal(current, features, 'reattachment does not grow terminal-features')
    assert.equal(current.split(/\s+/).filter(value => value === 'xterm*:clipboard:extkeys').length, 1)
  }
  await t.test('delayed negotiation cannot write to new terminals after the session is terminated', async () => {
    const fast = await create('Early exit')
    await terminal(fast.file, 'close')
    await service.terminate(target, fast.session.id)
    const observed = await execute('python3', ['-c', `
import json, os, select, time
pairs = [os.openpty() for _ in range(32)]
masters = [master for master, slave in pairs]
received = b''
deadline = time.monotonic() + 6.5
while time.monotonic() < deadline:
    for master in select.select(masters, [], [], 0.1)[0]:
        received += os.read(master, 4096)
print(json.dumps({'received': received.hex()}))
`], { env, timeout: 10_000 })
    assert.deepEqual(JSON.parse(observed.stdout), { received: '' }, 'no keyboard escape reaches a replacement PTY')
  })
})
