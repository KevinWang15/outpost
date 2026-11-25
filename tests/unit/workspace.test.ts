import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { harnessSoftware, setupTargets, type SoftwareId, type SoftwareStatus, type Target } from '../../shared/model'
import { sessionCreationOptions } from '../../shared/sessionCreation'
import { Installations } from '../../backend/installations'
import { LocalDeployment } from '../../backend/deployment'
import type { TargetContext } from '../../backend/sessions'
import type { SoftwareService } from '../../backend/software'
import { Workspace } from '../../backend/workspace'

const target = (fields: Partial<Target> = {}) =>
  ({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    kind: 'ssh',
    name: 'dev',
    host: 'dev.example.com',
    user: 'dev',
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
  assert.equal((await workspace.edit(added.id, { name: 'dev-box' })).name, 'dev-box')
  await assert.rejects(workspace.edit(added.id, { name: '   ' }), /Invalid machine/)
  await workspace.setEnvironment(added.id, { home: '/root', username: 'root', uid: 0, shell: '/bin/bash' })
  const saved = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8'))
  assert.equal(saved.version, 3)
  assert.equal(saved.targets[0].environment.home, '/root')
  await workspace.remove(added.id)
  assert.deepEqual(await workspace.list(), [])
  await writeFile(join(directory, 'workspace.json'), JSON.stringify({ ...saved, unknown: 1 }))
  await assert.rejects(workspace.list(), /no data was modified/)
})

test('one co-located machine per workspace and outbound machines rename cleanly', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-setup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspace = new Workspace(directory)
  const base = { createdAt: new Date().toISOString() }
  const local = await Promise.allSettled(
    ['A', 'B'].map(name => workspace.add({ ...base, id: crypto.randomUUID(), kind: 'local', name })),
  )
  assert.equal(local.filter(item => item.status === 'fulfilled').length, 1)
  const [saved] = await workspace.list()
  await workspace.remove(saved.id)
  await workspace.add({ ...base, id: crypto.randomUUID(), name: 'Replacement', kind: 'local' })
  const remote = await workspace.add({ ...base, id: crypto.randomUUID(), name: 'Remote', kind: 'outbound' })
  assert.equal((await workspace.edit(remote.id, { name: 'Build box' })).name, 'Build box')
})

test('seedLocalIfNew adds this computer once on fresh local workspaces and respects removal', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-seed-local-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspace = new Workspace(directory)

  const seeded = await workspace.seedLocalIfNew('  dev-workstation\n')
  assert.ok(seeded)
  assert.equal(seeded.kind, 'local')
  assert.equal(seeded.name, 'dev-workstation')
  assert.equal((await workspace.list()).length, 1)

  // Subsequent startups do not duplicate or alter an existing workspace.json.
  assert.equal(await workspace.seedLocalIfNew('other-host'), null)

  // Removing the seeded machine persists an empty workspace.json and never resurrects it.
  await workspace.remove(seeded.id)
  assert.deepEqual(await workspace.list(), [])
  assert.equal(await workspace.seedLocalIfNew('dev-workstation'), null)
  assert.deepEqual(await workspace.list(), [])

  // Blank hostnames fall back to "This computer".
  const fallbackDir = await mkdtemp(join(tmpdir(), 'outpost-seed-fallback-'))
  t.after(() => rm(fallbackDir, { recursive: true, force: true }))
  const fallback = await new Workspace(fallbackDir).seedLocalIfNew('   \x00 ')
  assert.equal(fallback?.name, 'This computer')

  // LocalDeployment.open seeds automatically when seedLocal is enabled on Linux, and respects removal on reopen.
  const deployDir = await mkdtemp(join(tmpdir(), 'outpost-seed-deploy-'))
  t.after(() => rm(deployDir, { recursive: true, force: true }))
  const first = await LocalDeployment.open(deployDir, undefined, { seedLocal: true, hostname: 'my-linux-box' })
  const initialTargets = await first.workspace().list()
  if (first.localTargets) {
    assert.equal(initialTargets.length, 1)
    assert.equal(initialTargets[0].kind, 'local')
    assert.equal(initialTargets[0].name, 'my-linux-box')
    await first.workspace().remove(initialTargets[0].id)
    const reopened = await LocalDeployment.open(deployDir, undefined, { seedLocal: true, hostname: 'my-linux-box' })
    assert.deepEqual(await reopened.workspace().list(), [])
  } else {
    assert.deepEqual(initialTargets, [])
  }
})

test('sessionCreationOptions auto-detects installed harnesses and separates core software requirements', () => {
  const item = (id: SoftwareStatus['id'], status: SoftwareStatus['status']): SoftwareStatus => ({
    id,
    status,
    path: status === 'installed' ? `/usr/bin/${id}` : null,
    version: status === 'installed' ? '1.0.0' : null,
    detail: null,
  })
  // Core software ready + two detected harnesses.
  assert.deepEqual(
    sessionCreationOptions([
      item('bash', 'installed'),
      item('outpost-terminal', 'installed'),
      item('claude', 'missing'),
      item('codex', 'installed'),
      item('kimi', 'missing'),
      item('deepseek', 'broken'),
      item('antigravity', 'installed'),
    ]),
    { tools: ['codex', 'antigravity'], missing: [] },
  )
  // Core software ready, zero harnesses installed yet.
  assert.deepEqual(sessionCreationOptions([item('bash', 'installed'), item('outpost-terminal', 'installed')]), {
    tools: [],
    missing: [],
  })
  // Core software missing even when a harness is installed.
  assert.deepEqual(
    sessionCreationOptions([
      item('bash', 'installed'),
      item('outpost-terminal', 'missing'),
      item('claude', 'installed'),
    ]),
    { tools: ['claude'], missing: ['outpost-terminal'] },
  )
  // Auto-setup requirements include Claude's chat adapter and always ensure core machine software.
  assert.deepEqual(harnessSoftware('claude'), ['claude', 'claude-agent-acp'])
  assert.deepEqual(harnessSoftware('codex'), ['codex'])
  assert.deepEqual(setupTargets(), ['bash', 'outpost-terminal'])
  assert.deepEqual(setupTargets(harnessSoftware('claude')), ['bash', 'outpost-terminal', 'claude', 'claude-agent-acp'])
})

test('installations run targeted harness setup, dedupe identical retries, and reject overlapping setups', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-install-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspace = new Workspace(directory)
  const machine = await workspace.add(target())
  const calls: (readonly SoftwareId[] | undefined)[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const software: SoftwareService = {
    async inspect() {
      return {
        environment: { home: '/home/dev', username: 'dev', uid: 1000, shell: '/bin/bash' },
        checkedAt: new Date().toISOString(),
        software: [],
      }
    },
    async setup(_context, output, _signal, requested) {
      calls.push(requested)
      output('installing\n')
      await gate
    },
  }
  const installations = new Installations(software)
  t.after(() => installations.close())
  const context = {
    owner: { userId: 'local', loginId: 'local' },
    target: machine,
    workspace,
  } as TargetContext

  const first = await installations.start(context, ['codex'])
  assert.deepEqual(first.software, ['codex'])
  // Same request while running is idempotent.
  const retry = await installations.start(context, ['codex'])
  assert.equal(retry.id, first.id)
  // Different software while running returns 409 conflict.
  await assert.rejects(
    installations.start(context, ['kimi']),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
  )
  release()
  await installations.close()
  assert.deepEqual(calls, [['codex']])
})
