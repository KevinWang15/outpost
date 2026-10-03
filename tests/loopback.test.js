import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import { createApp } from '../backend/app.ts'
import { TargetStore } from '../backend/store.ts'
import { loopbackHost } from '../shared/loopback.ts'

test('a spoofed localhost Host header cannot authorize a network client', async t => {
  const state = await mkdtemp(join(tmpdir(), 'outpost-loopback-'))
  const store = new TargetStore(state)
  const app = await createApp({ store })
  t.after(async () => { await app.close(); await rm(state, { recursive: true, force: true }) })
  const headers = { host: '127.0.0.1:3000', 'x-outpost-request': '1' }
  const payload = { kind: 'ssh', name: 'Review fixture', host: 'review.example.com', backends: ['tmux'], tools: ['codex'] }
  for (const remoteAddress of ['192.0.2.10', '::ffff:192.0.2.10', '2001:db8::1']) {
    assert.equal((await app.inject({ method: 'GET', url: '/api/targets', headers, remoteAddress })).statusCode, 403)
    assert.equal((await app.inject({ method: 'POST', url: '/api/targets', headers, remoteAddress, payload })).statusCode, 403)
  }
  assert.deepEqual(await store.list(), [])
  for (const remoteAddress of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
    assert.equal((await app.inject({ method: 'GET', url: '/api/targets', headers, remoteAddress })).statusCode, 200)
  }
})

test('listeners reject public interfaces and normalize localhost to a loopback address', () => {
  assert.equal(loopbackHost(undefined), '127.0.0.1')
  assert.equal(loopbackHost('localhost'), '127.0.0.1')
  assert.equal(loopbackHost('::1'), '::1')
  for (const host of ['0.0.0.0', '::', '192.0.2.10', 'example.com', '']) {
    assert.throws(() => loopbackHost(host), /only supports loopback/)
  }
})

test('Vite rejects a public host override before opening a listener', async () => {
  await assert.rejects(createServer({ server: { host: '0.0.0.0' } }), /only supports loopback/)
})
