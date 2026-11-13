// The state directory's primitives: locks across processes, atomic files and socket addresses.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { locked, readJson, socketAddress, state, statePath, writeJson } from '../../machine/state'
import { machine } from './fixtures'

test('a lock serializes its holders and is broken when its holder died', async t => {
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
  // A lock left by a process that has exited.
  const dead = spawnSync('true').pid!
  mkdirSync(statePath('locks'), { recursive: true })
  writeFileSync(statePath('locks', 'test.lock'), String(dead))
  assert.equal(await locked('test', () => 'acquired', 2000), 'acquired')
  assert.deepEqual(readdirSync(statePath('locks')), [], 'released and no stale copy left')
  // A live holder is waited for, up to the timeout.
  writeFileSync(statePath('locks', 'test.lock'), String(process.ppid))
  await assert.rejects(locked('test', () => 'never', 200))
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
  state.directory = join(process.cwd(), 'a'.repeat(100 - process.cwd().length))
  t.after(() => (state.directory = previous))
  assert.equal(socketAddress('run', 'x.sock'), relative(process.cwd(), statePath('run', 'x.sock')))
  state.directory = '/tmp/short'
  assert.equal(socketAddress('run', 'x.sock'), '/tmp/short/run/x.sock')
  state.directory = `/${'b'.repeat(200)}`
  assert.throws(() => socketAddress('run', 'x.sock'), /too long/)
})
