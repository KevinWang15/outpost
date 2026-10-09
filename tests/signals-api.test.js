import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { createApp } from '../backend/app.ts'
import { TargetStore } from '../backend/store.ts'
import { Signals } from '../backend/signals.ts'
import { SignalChannels } from '../backend/signal-channels.ts'

const execute = promisify(execFile)

test('desktop launch installs signals only on attachment, opens on the manager, and revokes the session on termination', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-signal-api-'))
  const store = new TargetStore(join(directory, 'manager')), signals = new Signals(() => true)
  const channels = new SignalChannels((token, body) => signals.dispatch(token, body))
  const opened = []
  let environment, script
  const app = await createApp({ store, signals, openBrowser: async url => { opened.push(url) }, service: {
    get: async (_target, id) => ({ id }), terminate: async (_target, id) => ({ id, status: 'stopped' }),
    prepareSignals: async (target, id, setup) => { environment = await channels.prepare(target, id, setup); return environment },
  }, desktop: {
    available: async () => ({ os: 'linux', terminals: [], recommendedId: null }),
    launch: async command => { script = command('bash'); return { terminalId: 'fixture' } },
  } })
  t.after(async () => { channels.close(); await app.close(); await rm(directory, { recursive: true, force: true }) })
  await store.add({ id: 'target', name: 'Local', kind: 'local', backends: ['tmux'], tools: ['codex'], createdAt: new Date().toISOString(),
    environment: { home: directory, uid: process.getuid(), username: 'fixture', shell: '/bin/bash', platform: 'linux' } })
  const request = path => app.inject({ method: 'POST', url: `/api/targets/target/sessions/work/${path}`, payload: {}, headers: { host: 'localhost', 'x-outpost-request': '1' } })
  assert.equal((await request('connect')).statusCode, 200)
  assert.equal(environment, undefined, 'preparing connection options never starts a receiver')
  const launched = await request('launch')
  assert.equal(launched.statusCode, 200, launched.body)
  assert.ok(environment.OUTPOST_SIGNAL_ENV)
  assert.equal(script.includes(environment.OUTPOST_SESSION_TOKEN), false, 'connection scripts carry a path, not a bearer token')
  assert.equal((await readFile(join(store.directory, 'targets.json'), 'utf8')).includes(environment.OUTPOST_SESSION_TOKEN), false)
  await execute(join(environment.OUTPOST_SIGNAL_BIN, 'outpost-browser'), ['https://example.com/download.zip'])
  assert.deepEqual(opened, ['https://example.com/download.zip'])
  assert.equal((await request('terminate')).statusCode, 200)
  await assert.rejects(execute(join(environment.OUTPOST_SIGNAL_BIN, 'outpost-browser'), ['https://example.com/no-listener']), { code: 1 })
  assert.equal(opened.length, 1)
})
