// The state directory's primitives: locks across processes, atomic files and socket addresses.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { locked, readJson, socketAddress, state, statePath, writeJson } from '../../machine/state'
import { machine } from './fixtures'

test('a lock serializes in-process holders and releases after a failed action', async t => {
  machine(t)
  const order: string[] = []
  await Promise.all(
    ['a', 'b', 'c'].map(name =>
      locked('test', async () => {
        order.push(`${name}+`)
        await new Promise(resolve => setTimeout(resolve, 20))
        order.push(`${name}-`)
      }),
    ),
  )
  for (let index = 0; index < order.length; index += 2) assert.equal(order[index][0], order[index + 1][0])
  await assert.rejects(
    locked('test', () => {
      throw Error('aborted')
    }),
    /aborted/,
  )
  assert.equal(await locked('test', () => 'acquired'), 'acquired')
  assert.deepEqual(readdirSync(statePath('locks')), ['test.lock'])
  assert.equal(statSync(statePath('locks', 'test.lock')).mode & 0o777, 0o600)
})

test('independent processes wait for the same key and acquire it after a holder is killed', async t => {
  machine(t)
  const module = new URL('../../machine/state.ts', import.meta.url).href
  function contender() {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import { once } from 'node:events'
        const { locked } = await import(process.argv[1])
        await locked('owner', async () => {
          process.send('held')
          await once(process, 'message')
        }, 5000, process.argv[2])
        process.disconnect()
      `,
        module,
        state.directory,
      ],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    )
    const exit = once(child, 'exit')
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exit
    })
    return { child, held: once(child, 'message', { signal: AbortSignal.timeout(5000) }), exit }
  }
  const first = contender()
  await first.held
  const next = contender()
  await assert.rejects(
    locked('owner', () => assert.fail('two simultaneous holders'), 80),
    /Outpost is busy/,
  )
  assert.equal(await locked('registry', () => 'independent', 80), 'independent')
  first.child.kill('SIGKILL')
  await first.exit
  await next.held
  await assert.rejects(
    locked('owner', () => assert.fail('stole the second holder’s lock'), 80),
    /Outpost is busy/,
  )
  next.child.send('release')
  const [code] = await next.exit
  assert.equal(code, 0)
  assert.equal(await locked('owner', () => 'released'), 'released')
})

test('rejects non-database lock files without modifying them', async t => {
  machine(t)
  mkdirSync(statePath('locks'), { recursive: true })
  const path = statePath('locks', 'owner.lock')
  writeFileSync(path, String(process.pid), { mode: 0o600 })
  await assert.rejects(
    locked('owner', () => assert.fail('entered invalid lock')),
    { errcode: 26 },
  )
  assert.equal(readFileSync(path, 'utf8'), String(process.pid))
})

test('files are replaced whole, privately, with no temporary left', async t => {
  machine(t)
  const path = statePath('nested', 'value.json')
  writeJson(path, { a: 1 })
  writeJson(path, { a: 2 })
  assert.deepEqual(readJson(path, null), { a: 2 })
  assert.deepEqual(readdirSync(statePath('nested')), ['value.json'])
  assert.equal(readJson(statePath('missing.json'), 'fallback'), 'fallback')
  writeFileSync(path, 'x'.repeat(100))
  assert.throws(() => readJson(path, null, 10), /size limit/)
  assert.ok(readFileSync(path))
})

test('a socket whose path is too long is addressed relative to the working directory', async t => {
  machine(t)
  const previous = state.directory
  state.directory = join(process.cwd(), 'a'.repeat(100 - Buffer.byteLength('/run/x.sock')))
  t.after(() => (state.directory = previous))
  assert.equal(socketAddress('run', 'x.sock'), relative(process.cwd(), statePath('run', 'x.sock')))
  state.directory = '/tmp/short'
  assert.equal(socketAddress('run', 'x.sock'), '/tmp/short/run/x.sock')
  state.directory = `/${'b'.repeat(200)}`
  assert.throws(() => socketAddress('run', 'x.sock'), /too long/)
})
