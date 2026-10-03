import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { SessionClient, connectScript } from '../backend/sessions.ts'
import { quote } from '../backend/shell.ts'

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
const targetInput = { kind: 'local', id: 'activity', name: 'Activity', backends: ['tmux', 'dtach'], tools: ['codex', 'claude', 'kimi'], createdAt: '2026-10-01T00:00:00Z' }

async function eventually(read, expected) {
  const deadline = Date.now() + 5000
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (value === expected) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(value, expected)
}
async function terminal(file, env) {
  const process = spawn('python3', [join(fixtures, 'terminal.py'), file, 'interactive'], { env })
  const lines = createInterface({ input: process.stdout })
  const messages = [], waiting = []
  let error = ''
  const exited = once(process, 'exit')
  process.stderr.on('data', chunk => { error += chunk })
  lines.on('line', line => {
    const data = JSON.parse(line)
    if (waiting.length) waiting.shift()(data)
    else messages.push(data)
  })
  const next = async () => Promise.race([
    messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiting.push(resolve)),
    exited.then(([code]) => { throw new Error(`Terminal exited with ${code}: ${error}`) }),
  ])
  const ready = await next()
  assert.equal(ready.ready, true)
  assert.equal(ready.focusReporting, true, 'focus reporting is requested on each tmux/dtach attachment')
  return {
    async input(bytes) { process.stdin.write(JSON.stringify({ input: Buffer.from(bytes).toString('base64') }) + '\n'); assert.equal((await next()).sent, true) },
    async close() { process.stdin.end(); const [code] = await exited; assert.equal(code, 0, error); lines.close() },
    process,
  }
}
function event(tool, state) {
  const timestamp = new Date().toISOString()
  if (tool === 'codex') return { type: 'event_msg', timestamp, payload: { type: state === 'working' ? 'task_started' : 'task_complete', turn_id: 'fixture' } }
  if (tool === 'claude') return { type: state === 'working' ? 'user' : 'assistant', timestamp, message: { role: state === 'working' ? 'user' : 'assistant', stop_reason: state === 'finished' ? 'end_turn' : null, content: 'PRIVATE_ACTIVITY_FIXTURE' } }
  return { type: state === 'working' ? 'turn.prompt' : 'turn.ended', agentId: 'main', time: Date.now(), turnId: 0, reason: 'completed' }
}

test('live native activity through both persistence backends: typing, focus, hangup, reconnect, and termination', { skip: process.platform === 'win32', timeout: 90_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'outpost-activity-local-'))
  const target = { ...targetInput, environment: { home, uid: process.getuid(), username: 'fixture', platform: process.platform, shell: '/bin/bash' } }
  const bin = join(home, 'bin')
  await mkdir(bin)
  await writeFile(join(home, '.hushlogin'), '')
  await writeFile(join(home, '.bash_profile'), `export PATH=${quote(bin)}:"$PATH"\n`)
  for (const tool of target.tools) await writeFile(join(bin, tool), await readFile(join(fixtures, 'coding-tool-fixture.py')), { mode: 0o700 })
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }
  const service = new SessionClient(env)
  const sessions = [], connections = []
  t.after(async () => {
    for (const connection of connections) connection.process.stdin.end()
    for (const session of sessions) await service.terminate(target, session.id).catch(() => {})
    await rm(home, { force: true, recursive: true })
  })
  for (const backend of target.backends) for (const tool of target.tools) await t.test(`${backend} / ${tool}`, async () => {
    const root = join(home, `${backend}-${tool}`)
    await mkdir(root)
    const session = await service.create(target, { name: `${backend}-${tool}`, rootDir: root, tool, backend })
    await writeFile(join(root, 'capture-input'), '')
    sessions.push(session)
    const file = join(home, `${backend}-${tool}.sh`)
    await writeFile(file, connectScript(target, session.id, 'bash'))
    let connection = await terminal(file, env)
    connections.push(connection)
    const nativeHome = Object.values(session.cliSessionEnv)[0]
    const paths = await readdir(nativeHome, { recursive: true })
    const path = join(nativeHome, paths.find(path => tool === 'kimi' ? path.endsWith(`${session.cliSessionId}/agents/main/wire.jsonl`) : path.endsWith(`${session.cliSessionId}.jsonl`)))
    const append = async state => appendFile(path, JSON.stringify(event(tool, state)) + '\n')
    const state = async () => (await service.get(target, session.id)).activity.state
    const pid = JSON.parse(await readFile(join(root, 'heartbeat.json'), 'utf8')).pid
    await append('working')
    await eventually(state, 'working')
    await append('finished')
    await eventually(state, 'finished')
    await connection.input('\x1b[?1;2c\x1b[O')
    assert.equal(await state(), 'finished', 'terminal replies and focus-out cannot consume unread completion')
    await connection.input('x')
    await eventually(state, 'idle')
    await append('working')
    await connection.input('y')
    assert.equal(await state(), 'working')
    await append('finished')
    await eventually(state, 'finished')
    await connection.input('\x1b[I')
    await eventually(state, 'idle')
    await append('finished')
    await connection.close()
    await eventually(state, 'finished')
    assert.equal((await service.get(target, session.id)).status, 'detached')
    connection = await terminal(file, env)
    connections.push(connection)
    await eventually(state, 'idle')
    assert.equal(JSON.parse(await readFile(join(root, 'heartbeat.json'), 'utf8')).pid, pid)
    const result = await service.terminate(target, session.id)
    assert.equal(result.status, 'stopped')
    assert.equal(result.activity.state, 'idle')
    await connection.close()
    const metadata = await readFile(join(home, '.outpost', 'activity', session.id + '.json'), 'utf8')
    assert.equal(metadata.includes('PRIVATE_ACTIVITY_FIXTURE'), false)
    assert.equal((await readFile(join(home, '.outpost', 'sessions.json'), 'utf8')).includes('PRIVATE_ACTIVITY_FIXTURE'), false)
  })
})
