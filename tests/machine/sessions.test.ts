// Sessions on a machine: creation, forks, edits and the registry, with fixture coding tools.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { currentConversation, type SessionInput } from '../../shared/model'
import { checkImage, saveImage } from '../../machine/files'
import { readRegistry } from '../../machine/registry'
import {
  createSession,
  deleteSession,
  forkSession,
  listSessions,
  switchSession,
  updateSession,
} from '../../machine/sessions'
import { statePath } from '../../machine/state'
import { machine, record, register, tools } from './fixtures'

function setup(t: TestContext) {
  const home = machine(t)
  const bin = tools(t, home)
  const project = join(home, 'project')
  mkdirSync(project)
  const input = (overrides: Partial<SessionInput> = {}): SessionInput => ({
    name: 'Build',
    rootDir: project,
    tool: 'claude',
    ...overrides,
  })
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const repository = () => {
    git(project, 'init', '-q', '-b', 'main')
    writeFileSync(join(project, 'tracked.txt'), 'committed content')
    git(project, 'add', 'tracked.txt')
    git(project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'Initial')
  }
  const registryBytes = () => readFileSync(statePath('registry.json'))
  return { home, bin, project, input, git, repository, registryBytes }
}

test('a creation receipt replays the session, refuses changed settings and never resurrects it', async t => {
  const { input } = setup(t)
  const key = 'a'.repeat(64)
  const request = input({ name: 'Retryable', env: { A: '1', B: '2' } })
  const first = await createSession(request, key)
  const again = await createSession({ ...request, env: { A: '1', B: '2' } }, key)
  assert.equal(again.id, first.id)
  assert.equal(currentConversation(again), currentConversation(first))
  assert.equal((await listSessions()).length, 1)
  await assert.rejects(createSession({ ...request, name: 'Changed' }, key), {
    status: 409,
    message: /different session settings/,
  })
  await deleteSession(first.id)
  await assert.rejects(createSession(request, key), { status: 410 })
  assert.deepEqual(await listSessions(), [])
  assert.equal(readRegistry().creations[key].sessionId, first.id)
})

test('concurrent replays of one creation commit exactly one session', async t => {
  const { input } = setup(t)
  const created = await Promise.all([1, 2, 3].map(() => createSession(input(), 'b'.repeat(64))))
  assert.equal(new Set(created.map(session => session.id)).size, 1)
  assert.equal((await listSessions()).length, 1)
})

test('a failed creation does not use up its request identity', async t => {
  const { input, project } = setup(t)
  const root = join(project, 'not-yet-created')
  const request = input({ rootDir: root })
  await assert.rejects(createSession(request, 'c'.repeat(64)), { status: 400 })
  mkdirSync(root)
  const first = await createSession(request, 'c'.repeat(64))
  assert.equal((await createSession(request, 'c'.repeat(64))).id, first.id)
})

test('names are unique on a machine, ignoring case, and arguments must parse', async t => {
  const { input } = setup(t)
  await createSession(input({ name: 'Same' }))
  await assert.rejects(createSession(input({ name: 'same', tool: 'codex' })), { status: 409 })
  await assert.rejects(createSession(input({ name: 'Quote', args: '"unclosed' })), {
    status: 400,
    message: /Invalid Bash argument syntax/,
  })
  await assert.rejects(createSession(input({ name: 'Resume', args: '--resume other' })), {
    status: 400,
    message: /controls the coding tool conversation/,
  })
})

test('an invalid registry is reported and never rewritten', async t => {
  const { input, registryBytes } = setup(t)
  await createSession(input())
  const data = JSON.parse(registryBytes().toString())
  assert.equal(data.version, 3)
  writeFileSync(statePath('registry.json'), JSON.stringify({ ...data, extra: true }))
  await assert.rejects(listSessions(), /Invalid session registry/)
  await assert.rejects(createSession(input({ name: 'Other' })), /Invalid session registry/)
  assert.match(registryBytes().toString(), /"extra":true/)
})

test('a conversation belongs to one session; a resumed one moves', async t => {
  const home = machine(t)
  const conversation = '33333333-3333-4333-8333-333333333333'
  const first = record(home, 'claude', conversation)
  await register(first)
  await assert.rejects(register(record(home, 'claude', conversation)), /conversation in two sessions/)
  // The same ID in another store is another conversation.
  await register(record(home, 'claude', conversation, { storage: { CLAUDE_CONFIG_DIR: join(home, 'other') } }))
})

test('edits make a new revision; a stale edit is refused', async t => {
  const { input } = setup(t)
  const session = await createSession(input({ env: { MODEL: 'a' } }))
  assert.equal(session.config.revision, 1)
  const renamed = await updateSession(session.id, { revision: 1, name: 'Renamed' })
  assert.equal(renamed.name, 'Renamed')
  assert.equal(renamed.config.revision, 1, 'a name is not launch configuration')
  const edited = await updateSession(session.id, { revision: 1, env: { MODEL: 'b' }, instructions: '  Be brief.  ' })
  assert.equal(edited.config.revision, 2)
  assert.deepEqual(edited.config.env, { MODEL: 'b' })
  assert.equal(edited.config.instructions, 'Be brief.')
  await assert.rejects(updateSession(session.id, { revision: 1, args: '--verbose' }), { status: 409 })
  await createSession(input({ name: 'Other' }))
  await assert.rejects(updateSession(session.id, { revision: 2, name: 'other' }), { status: 409 })
  await assert.rejects(updateSession(session.id, { revision: 2, args: "'" }), { status: 400 })
  assert.equal(readRegistry().sessions.find(item => item.id === session.id)!.config.revision, 2)
})

test('switching makes an earlier conversation current, but not one that moved', async t => {
  const home = machine(t)
  const [a, b, c] = ['1', '2', '3'].map(digit => `${digit.repeat(8)}-1111-4111-8111-111111111111`)
  const session = record(home, 'claude', a)
  session.conversations.push({ id: b, startedAt: session.createdAt, movedTo: null })
  session.conversations.push({ id: c, startedAt: session.createdAt, movedTo: 'elsewhere' })
  await register(session)
  const switched = await switchSession(session.id, a)
  assert.equal(currentConversation(switched), a)
  assert.deepEqual(
    switched.conversations.map(item => item.id),
    [b, c, a],
  )
  await assert.rejects(switchSession(session.id, c), /moved to another session/)
  await assert.rejects(switchSession(session.id, 'unknown'), { status: 404 })
})

test('a fork is a new session in a new worktree, with the source settings and a new conversation', async t => {
  const { input, home, project, git, repository } = setup(t)
  repository()
  writeFileSync(join(project, 'tracked.txt'), 'uncommitted content')
  for (const tool of ['claude', 'codex', 'kimi'] as const) {
    const source = await createSession(input({ name: tool, tool, env: { MODEL: 'fixture' }, args: '--model "$MODEL"' }))
    const branch = `feature/${tool}`
    const destination = join(home, `${tool} fork's worktree`)
    const fork = await forkSession(source.id, branch, destination)
    assert.equal(fork.rootDir, destination)
    assert.equal(fork.name, branch)
    assert.equal(fork.tool, tool)
    assert.deepEqual(fork.config.env, source.config.env)
    assert.equal(fork.config.args, source.config.args)
    assert.deepEqual(fork.storage, source.storage)
    assert.notEqual(currentConversation(fork), currentConversation(source))
    assert.equal(fork.status, 'ready')
    assert.equal(fork.lastConnectedAt, null)
    assert.ok(statSync(join(destination, '.git')).isFile())
    assert.equal(git(destination, 'branch', '--show-current'), branch)
    assert.equal(git(destination, 'rev-parse', 'HEAD'), git(project, 'rev-parse', 'HEAD'))
    assert.equal(readFileSync(join(destination, 'tracked.txt'), 'utf8'), 'committed content')
  }
  assert.equal(readFileSync(join(project, 'tracked.txt'), 'utf8'), 'uncommitted content')
  assert.equal(git(project, 'branch', '--show-current'), 'main')
})

test('a Git failure creates no session and no worktree', async t => {
  const { input, home, project, git, repository, registryBytes } = setup(t)
  const source = await createSession(input())
  const original = registryBytes()
  const destination = join(home, 'fork')
  await assert.rejects(forkSession(source.id, 'feature/new', destination), {
    status: 409,
    message: /not a git repository/,
  })
  assert.deepEqual(registryBytes(), original)
  assert.equal(existsSync(destination), false)
  repository()
  for (const branch of ['main', '--detach', 'invalid..branch', '@{-1}']) {
    await assert.rejects(forkSession(source.id, branch, destination), Error, branch)
    assert.deepEqual(registryBytes(), original)
    assert.equal(existsSync(destination), false)
  }
  mkdirSync(destination)
  writeFileSync(join(destination, 'keep.txt'), 'keep this')
  await assert.rejects(forkSession(source.id, 'feature/new', destination), /already exists/)
  assert.equal(readFileSync(join(destination, 'keep.txt'), 'utf8'), 'keep this')
  assert.equal(git(project, 'branch', '--format=%(refname:short)'), 'main')
})

test('a fork keeps literal paths and avoids name collisions', async t => {
  const { input, home, project, repository } = setup(t)
  repository()
  const source = await createSession(input({ name: 'feature/fork' }))
  const destination = join(home, 'fork;$(touch injected)')
  const fork = await forkSession(source.id, source.name, destination)
  assert.equal(fork.name, 'feature/fork (2)')
  assert.equal(fork.rootDir, destination)
  assert.equal(existsSync(join(project, 'injected')), false)
  await assert.rejects(forkSession(crypto.randomUUID(), 'x', join(home, 'other')), { status: 404 })
})

test('a fork whose conversation cannot be allocated reports the worktree it made', async t => {
  const { input, home, bin, git, repository, registryBytes } = setup(t)
  repository()
  const source = await createSession(input({ tool: 'codex' }))
  const original = registryBytes()
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 1\n')
  const destination = join(home, 'fork-without-session')
  await assert.rejects(forkSession(source.id, 'feature/no-cli', destination), {
    status: 409,
    message: new RegExp(`Worktree created at ${destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  })
  assert.deepEqual(registryBytes(), original)
  assert.equal(git(destination, 'branch', '--show-current'), 'feature/no-cli')
})

test('pasted images: valid types and sizes, private files, the newest 20 kept', async t => {
  const { input } = setup(t)
  const session = await createSession(input())
  const data = Buffer.concat([Buffer.from([...Array(256).keys()]), Buffer.from(' \r\n')])
  const saved = Array.from({ length: 23 }, (_, index) =>
    saveImage(session.id, ['png', 'jpg', 'gif', 'webp'][index % 4], data),
  )
  const directory = statePath('clipboard', session.id)
  assert.equal(readdirSync(directory).length, 20)
  assert.equal(existsSync(saved[0].path), false)
  for (const image of saved.slice(-20)) {
    assert.deepEqual(readFileSync(image.path), data)
    assert.equal(statSync(image.path).mode & 0o777, 0o600)
    assert.ok(image.reference.startsWith(directory))
  }
  for (const size of [0, -1, 16 * 1024 * 1024 + 1, 1.5])
    assert.throws(() => checkImage(session.id, 'png', size), { status: 413 })
  for (const extension of ['../png', 'svg', 'PNG'])
    assert.throws(() => checkImage(session.id, extension, 1), { status: 400 })
  assert.throws(() => checkImage(crypto.randomUUID(), 'png', 1), { status: 404 })
  await deleteSession(session.id)
  assert.equal(existsSync(directory), false, 'deleting a session removes its images')
})
