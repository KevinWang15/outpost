import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Target } from '../../shared/model'
import { Workspace } from '../../backend/workspace'

const target = (fields: Partial<Target> = {}) =>
  ({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    kind: 'ssh',
    name: 'dev',
    host: 'dev.example.com',
    user: 'dev',
    tools: ['claude'],
    ...fields,
  }) as Target

test('workspace stores targets atomically with a strict schema', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-workspace-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspace = new Workspace(directory)
  const added = await workspace.add(target())
  await assert.rejects(workspace.add(target({ name: 'DEV' })), /name already exists/)
  const invalid = { ...target(), extra: true }
  await assert.rejects(workspace.add(invalid), /Invalid machine/)
  assert.deepEqual((await workspace.edit(added.id, { tools: ['codex', 'kimi'] })).tools, ['codex', 'kimi'])
  await assert.rejects(workspace.edit(added.id, { tools: [] }), /Invalid machine/)
  await workspace.setEnvironment(added.id, { home: '/root', username: 'root', uid: 0, shell: '/bin/bash' })
  const saved = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8'))
  assert.equal(saved.version, 3)
  assert.equal(saved.targets[0].environment.home, '/root')
  await workspace.remove(added.id)
  assert.deepEqual(await workspace.list(), [])
  await writeFile(join(directory, 'workspace.json'), JSON.stringify({ ...saved, unknown: 1 }))
  await assert.rejects(workspace.list(), /no data was modified/)
})

test('one co-located machine per workspace and all coding tools on outbound machines', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-setup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspace = new Workspace(directory)
  const base = { createdAt: new Date().toISOString(), tools: ['codex' as const] }
  const local = await Promise.allSettled(
    ['A', 'B'].map(name => workspace.add({ ...base, id: crypto.randomUUID(), kind: 'local', name })),
  )
  assert.equal(local.filter(item => item.status === 'fulfilled').length, 1)
  const [saved] = await workspace.list()
  await workspace.remove(saved.id)
  await workspace.add({ ...base, id: crypto.randomUUID(), name: 'Replacement', kind: 'local' })
  const remote = await workspace.add({ ...base, id: crypto.randomUUID(), name: 'Remote', kind: 'outbound' })
  assert.deepEqual((await workspace.edit(remote.id, { tools: ['deepseek'] })).tools, ['deepseek'])
})
