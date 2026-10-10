import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { loadNativePty, nativeSession } from '../backend/native-session.ts'

function terminal() {
  const input = new PassThrough(), output = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk.toString()); done() } })
  const chunks = []
  input.isTTY = output.isTTY = true; input.isRaw = false
  input.setRawMode = value => { input.isRaw = value; return input }
  output.columns = 100; output.rows = 30
  return { input, output, text: () => chunks.join('') }
}
async function until(predicate) {
  const end = Date.now() + 8000
  while (Date.now() < end) { if (await predicate()) return; await delay(20) }
  assert.fail('Timed out waiting for the terminal fixture')
}

test('native terminal bridges stay isolated, forward input and resize, and clean up on closure', async () => {
  const sessions = [], modules = [], connections = [], uploads = [], reads = []
  for (let index = 0; index < 2; index++) {
    const fixture = terminal(), writes = [], sizes = []
    let onData, onExit, killed = false
    const pty = {
      write: data => writes.push(data), resize: (...size) => sizes.push(size), pause() {}, resume() {}, kill: () => { killed = true },
      onData: handler => { onData = handler; return { dispose() {} } },
      onExit: handler => { onExit = handler; return { dispose() {} } },
    }
    const promise = nativeSession({ executable: 'fixture', args: [], label: 'Fixture' }, {
      ...fixture, pty: { spawn: () => pty },
      readClipboard: async () => { reads.push(index); return { kind: 'image', image: { mediaType: 'image/png', data: 'bytes' } } },
      upload: async () => { uploads.push(index); return { path: '/remote/image.png', reference: '/remote/image.png', injected: false } },
    })
    modules.push({ fixture, writes, sizes, get killed() { return killed } })
    connections.push({ data: onData, exit: onExit })
    sessions.push(promise)
  }
  connections[0].data('\x1b[?2004h\x1b]52;c;?\x07')
  await delay(20)
  assert.deepEqual(reads, [], 'remote output never reads the clipboard')
  modules[0].fixture.input.write('\x1b[19~')
  await until(() => modules[0].writes.length)
  assert.deepEqual(reads, [0]); assert.deepEqual(uploads, [0])
  assert.deepEqual(modules[0].writes, ['\x1b[200~/remote/image.png\x1b[201~'])
  assert.deepEqual(modules[1].writes, [])
  modules[1].fixture.input.write('hé🙂\x1b[A\x03')
  await until(() => modules[1].writes.length)
  assert.equal(modules[1].writes.join(''), 'hé🙂\x1b[A\x03')
  modules[0].fixture.output.columns = 120; modules[0].fixture.output.rows = 40
  modules[0].fixture.output.emit('resize')
  assert.deepEqual(modules[0].sizes, [[120, 40]])
  for (const { fixture } of modules) fixture.input.end()
  assert.deepEqual(await Promise.all(sessions), [0, 0])
  for (const { fixture, killed } of modules) {
    assert.equal(killed, true); assert.equal(fixture.input.isRaw, false)
    assert.equal(fixture.input.listenerCount('data'), 0)
    assert.equal(fixture.output.listenerCount('resize'), 0)
  }
})

test('a real PTY preserves Unicode arguments and raw terminal input, image paste, resizing and explicit reconnect', { timeout: 30_000 }, async t => {
  let pty
  try { pty = await loadNativePty() }
  catch (error) {
    if (process.platform === 'darwin' || process.platform === 'win32') throw error
    return t.skip('Optional PTY binding is not installed on this Linux host')
  }
  const directory = await mkdtemp(join(tmpdir(), 'outpost-native-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const capture = join(directory, 'input.jsonl'), fixture = terminal(), writes = []
  const script = `const fs = require('node:fs');
const record = value => fs.appendFileSync(process.argv[1], JSON.stringify(value) + '\\n');
record({ args: process.argv.slice(2), tty: [process.stdin.isTTY, process.stdout.isTTY, process.stderr.isTTY], cols: process.stdout.columns, rows: process.stdout.rows });
process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');
process.stdout.on('resize', () => record({ resized: [process.stdout.columns, process.stdout.rows] }));
process.stdin.on('data', data => { if (data.includes('\\x04')) process.exit(7); else record({ data }) });
process.stdout.write('\\x1b[?2004hNATIVE_READY\\r\\n');`
  const args = ['space & 漢🙂', "O’Brien 'quotes'", '$(literal)', 'a"b\\', '~/private key']
  const session = nativeSession({ executable: process.execPath, args: ['-e', script, capture, ...args], label: 'Fixture', expandHome: true }, {
    ...fixture, pty, readClipboard: async () => ({ kind: 'image', image: { mediaType: 'image/png', data: 'fixture' } }),
    upload: async image => { writes.push(image); return { path: '/remote/image.png', reference: '/remote/image.png', injected: false } },
  })
  t.after(async () => { fixture.input.end(); await session })
  const records = async () => { try { return (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) } catch { return [] } }
  await until(() => fixture.text().includes('NATIVE_READY'))
  const first = (await records())[0]
  assert.deepEqual(first, { args: [...args.slice(0, -1), join(homedir(), 'private key')], tty: [true, true, true], cols: 100, rows: 30 })
  fixture.input.write('本地🙂\x1b[A\x03')
  fixture.input.write('\x1b[19~')
  await until(async () => (await records()).filter(record => record.data).map(record => record.data).join('').includes('/remote/image.png'))
  assert.equal((await records()).filter(record => record.data).map(record => record.data).join(''), '本地🙂\x1b[A\x03\x1b[200~/remote/image.png\x1b[201~')
  assert.equal(writes.length, 1)
  fixture.output.columns = 110; fixture.output.rows = 35; fixture.output.emit('resize')
  await until(async () => (await records()).some(record => record.resized?.join(',') === '110,35'))
  fixture.input.write('\x04')
  await until(() => fixture.text().includes('DISCONNECTED'))
  fixture.input.write('x')
  await delay(80)
  assert.equal((await records()).filter(record => record.args).length, 1)
  fixture.input.write('\r')
  await until(async () => (await records()).filter(record => record.args).length === 2)
  fixture.input.write('\x04')
  await until(() => fixture.text().split('DISCONNECTED').length === 3)
  fixture.input.write('\x03')
  assert.equal(await session, 0)
  assert.equal(fixture.input.isRaw, false)
})
