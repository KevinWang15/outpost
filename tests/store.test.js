import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TargetStore } from '../backend/store.ts'

const target = { id: 'target', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', name: 'Dev', host: 'dev', backends: ['tmux'], createdAt: '2026-09-30T00:00:00Z' }

test('stored configuration must match the current schema; invalid data is never rewritten', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-store-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new TargetStore(directory)
  const secret = await store.secret()
  const file = join(directory, 'targets.json')
  const missingKind = { ...target }; delete missingKind.kind
  const missingBackends = { ...target }; delete missingBackends.backends
  for (const config of [
    { secret, remotes: [target] },
    { secret, targets: [missingKind] },
    { secret, targets: [missingBackends] },
    { secret, targets: [{ ...target, backends: [] }] },
    { secret, targets: [{ ...target, backends: ['tmux', 'tmux'] }] },
    { secret, targets: [{ ...target, backends: ['screen'] }] },
    { secret, targets: [{ ...target, port: '22' }] },
    { secret, targets: [{ ...target, tools: ['codex', 'kimi', 'claude'], kind: 'local' }] },
    { secret, targets: [{ ...target, distribution: 'Ubuntu' }] },
    { secret, targets: [{ ...target, environment: { home: '/root' } }] },
    { secret, targets: [target, target] },
    { secret, targets: [target, { ...target, id: 'another', name: 'dev' }] },
    { secret: '', targets: [] },
    { secret, targets: [], legacy: true },
  ]) {
    const contents = JSON.stringify(config)
    await writeFile(file, contents)
    await assert.rejects(store.list(), /configuration/)
    await assert.rejects(store.add(target), /configuration/)
    await assert.rejects(store.secret(), /configuration/)
    assert.equal(await readFile(file, 'utf8'), contents)
  }
  await writeFile(file, JSON.stringify({ secret, targets: [] }))
  await store.add(target)
  assert.deepEqual(await store.list(), [target])
  await assert.rejects(store.add({ ...target, backends: undefined }), /configuration/)
  assert.deepEqual(await store.list(), [target])
})

test('environment discovery and removal are serialized without an upsert race', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-store-race-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new TargetStore(directory)
  const environment = { home: '/root', username: 'root', uid: 0, platform: 'linux', shell: '/bin/bash' }
  await store.add(target)
  const removal = store.remove(target.id)
  const updating = store.updateEnvironment(target.id, environment)
  await assert.rejects(updating, { statusCode: 404 })
  await removal
  assert.deepEqual(await store.list(), [])
  await store.add(target)
  await Promise.all([store.updateEnvironment(target.id, environment), store.remove(target.id)])
  assert.deepEqual(await store.list(), [])
})

test('requirements edits and live environment discovery preserve each other and never recreate a removed target', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-requirements-race-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new TargetStore(directory)
  const environment = { home: '/root', username: 'root', uid: 0, platform: 'linux', shell: '/bin/bash' }
  const requirements = { backends: ['tmux', 'dtach'], tools: ['kimi'] }
  await store.add(target)
  await Promise.all([store.updateRequirements(target.id, requirements), store.updateEnvironment(target.id, environment)])
  assert.deepEqual(await new TargetStore(directory).get(target.id), { ...target, ...requirements, environment })
  const changed = { backends: ['dtach'], tools: ['claude'] }
  await Promise.all([store.updateEnvironment(target.id, environment), store.updateRequirements(target.id, changed)])
  assert.deepEqual(await store.get(target.id), { ...target, ...changed, environment })
  const removal = store.remove(target.id)
  await assert.rejects(store.updateRequirements(target.id, requirements), { statusCode: 404 })
  await removal
  assert.deepEqual(await store.list(), [])
})

test('adding a target never silently replaces an existing target identity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-store-add-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new TargetStore(directory)
  await store.add(target)
  const file = join(directory, 'targets.json')
  const before = await readFile(file, 'utf8')
  await assert.rejects(store.add({ ...target, name: 'Replacement', host: 'elsewhere' }), { statusCode: 409 })
  assert.equal(await readFile(file, 'utf8'), before)
  assert.deepEqual(await store.get(target.id), target)
})
