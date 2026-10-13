import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Target } from '../../shared/model'
import { importV1, Workspace } from '../../backend/workspace'

const target = (fields: Partial<Target> = {}) =>
  ({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    kind: 'ssh',
    name: 'dev',
    host: 'dev.example.com',
    tools: ['claude'],
    ...fields,
  }) as Target

test('workspace stores targets atomically with a strict schema', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-workspace-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspace = new Workspace(directory)
  const added = await workspace.add(target())
  await assert.rejects(workspace.add(target({ name: 'DEV' })), /name already exists/)
  await assert.rejects(workspace.add({ ...target(), extra: true } as Target), /Invalid target/)
  assert.deepEqual((await workspace.edit(added.id, { tools: ['codex', 'kimi'] })).tools, ['codex', 'kimi'])
  await assert.rejects(workspace.edit(added.id, { tools: [] }), /Invalid target/)
  await workspace.setEnvironment(added.id, { home: '/root', username: 'root', uid: 0, shell: '/bin/bash' })
  const saved = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8'))
  assert.equal(saved.version, 2)
  assert.equal(saved.targets[0].environment.home, '/root')
  await workspace.remove(added.id)
  assert.deepEqual(await workspace.list(), [])
  await writeFile(join(directory, 'workspace.json'), JSON.stringify({ ...saved, unknown: 1 }))
  await assert.rejects(workspace.list(), /no data was modified/)
})

test('v1 targets.json is imported once and left untouched', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-import-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const v1 = {
    secret: 'f'.repeat(64),
    targets: [
      {
        id: 'a',
        name: 'Server',
        createdAt: '2026-01-01',
        kind: 'ssh',
        host: 'dev',
        port: 2222,
        backends: ['tmux', 'dtach'],
        tools: ['codex'],
        environment: { home: '/root', platform: 'linux', username: 'root', uid: 0, shell: '/bin/bash' },
      },
      {
        id: 'b',
        name: 'Windows box',
        createdAt: '2026-01-01',
        kind: 'local',
        distribution: 'Ubuntu',
        backends: ['tmux'],
        tools: ['claude'],
      },
      {
        id: 'c',
        name: 'Mac',
        createdAt: '2026-01-01',
        kind: 'local',
        backends: ['dtach'],
        tools: ['kimi'],
        environment: { home: '/Users/me', platform: 'darwin', username: 'me', uid: 501, shell: '/bin/zsh' },
      },
    ],
  }
  await writeFile(join(directory, 'targets.json'), JSON.stringify(v1))
  const workspace = new Workspace(directory)
  const targets = await workspace.list()
  assert.deepEqual(
    targets.map(item => item.id),
    ['a', 'c'],
  )
  assert.deepEqual(targets[0], {
    id: 'a',
    name: 'Server',
    createdAt: '2026-01-01',
    kind: 'ssh',
    host: 'dev',
    port: 2222,
    tools: ['codex'],
    environment: { home: '/root', username: 'root', uid: 0, shell: '/bin/bash' },
  })
  assert.equal(targets[1].environment, undefined, 'macOS execution details are dropped')
  await workspace.add(target({ name: 'New' }))
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'targets.json'), 'utf8')), v1)
  assert.deepEqual(importV1({ nonsense: true }), [])
})
