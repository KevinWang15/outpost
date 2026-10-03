import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runCommand, runProtocol } from '../backend/process.ts'

const command = { executable: process.execPath, args: [], label: 'Test runtime' }
const run = source => runProtocol(command, source)

async function workerTree(t) {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-process-tree-'))
  const file = join(directory, 'pid')
  let pid
  t.after(async () => {
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch { /* Already exited. */ } }
    await rm(directory, { recursive: true, force: true })
  })
  const source = `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] })
    require('node:fs').writeFileSync(${JSON.stringify(file)}, String(child.pid))
    setInterval(() => {}, 1000)
  `
  async function started() {
    for (let i = 0; i < 100 && !pid; i++) {
      pid = Number(await readFile(file, 'utf8').catch(() => ''))
      if (!pid) await delay(20)
    }
    assert.ok(pid, 'worker started its child')
  }
  async function stopped() {
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid, 0)
        if (process.platform === 'linux' && (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].startsWith('Z ')) return
      } catch { return }
      await delay(20)
    }
    assert.fail('the command child was left running')
  }
  return { source, started, stopped }
}

test('timeouts settle promptly and stop children which inherited output pipes', { timeout: 6000 }, async t => {
  const worker = await workerTree(t)
  const startedAt = Date.now()
  const pending = runCommand(command, worker.source, { timeoutMs: 1000 })
  const rejection = assert.rejects(pending, /timed out/)
  await worker.started()
  await Promise.race([rejection, delay(2500).then(() => assert.fail('timeout waited for inherited pipes to close'))])
  assert.ok(Date.now() - startedAt < 2500, 'the configured timeout bounds the request')
  await worker.stopped()
})

test('aborting a command also stops children which inherited output pipes', { timeout: 6000 }, async t => {
  const worker = await workerTree(t)
  const controller = new AbortController()
  const pending = runCommand(command, worker.source, { signal: controller.signal })
  const rejection = assert.rejects(pending, /aborted/)
  await worker.started()
  controller.abort()
  await rejection
  await worker.stopped()
})

test('protocol preserves UTF-8 across writes and ignores shell startup chatter', async () => {
  const result = await run(`
    process.stdout.write('Shell startup output\\n')
    const value = Buffer.from('OUTPOST_RESULT:' + JSON.stringify({ ok: true, data: { name: '你好 é' } }) + '\\n')
    const index = value.indexOf(Buffer.from('你')) + 1
    process.stdout.write(value.subarray(0, index))
    setTimeout(() => process.stdout.write(value.subarray(index)), 20)
  `)
  assert.deepEqual(result, { name: '你好 é' })
})

test('protocol rejects malformed envelopes and nonzero exits; errors have explicit status', async () => {
  for (const value of [null, {}, { home: '/root' }, { error: 'old shape', status: 409 }, { ok: true },
    { ok: true, data: {}, error: { message: 'Mixed envelope', status: 409 } },
    { ok: true, data: {}, extra: true }, { ok: false, error: { message: 'Bad status', status: 200 } },
    { ok: false, error: { message: 'Extra error fields', status: 409, extra: true } }]) {
    await assert.rejects(run(`console.log('OUTPOST_RESULT:' + JSON.stringify(${JSON.stringify(value)}))`), /Invalid response/)
  }
  await assert.rejects(run("console.log('OUTPOST_RESULT:' + JSON.stringify({ ok: false, error: { message: 'Not found', status: 404 } }))"), { message: 'Not found', statusCode: 404 })
  await assert.rejects(run("console.log('OUTPOST_RESULT:' + JSON.stringify({ ok: true, data: {} })); process.exitCode = 23"), /failed \(23\)/)
  assert.equal((await run("console.log('OUTPOST_RESULT:' + JSON.stringify({ ok: true, data: null }))")), null)
})

test('aborting an operation kills its worker even when startup scripts ignored SIGTERM', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-process-'))
  const file = join(directory, 'pid')
  let pid
  t.after(async () => {
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch { /* Already exited. */ } }
    await rm(directory, { recursive: true, force: true })
  })
  const controller = new AbortController()
  const pending = runProtocol(command, `
    process.on('SIGTERM', () => {})
    require('node:fs').writeFileSync(${JSON.stringify(file)}, String(process.pid))
    setInterval(() => {}, 1000)
  `, { signal: controller.signal })
  const rejection = assert.rejects(pending, /aborted/)
  for (let i = 0; i < 100 && !pid; i++) {
    pid = Number(await readFile(file, 'utf8').catch(() => ''))
    if (!pid) await delay(20)
  }
  assert.ok(pid, 'worker started')
  controller.abort()
  await rejection
  let exited = false
  for (let i = 0; i < 100 && !exited; i++) {
    try { process.kill(pid, 0); await delay(20) } catch { exited = true }
  }
  assert.equal(exited, true, 'aborting cannot orphan a worker that ignores SIGTERM')
  pid = undefined
})
