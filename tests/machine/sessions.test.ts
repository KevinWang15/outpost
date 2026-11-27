// Sessions on a machine: creation, forks, edits and the registry, with fixture coding tools.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { argsSelectSession, previewStartCommand } from '../../shared/harnesses'
import type { SessionInput } from '../../shared/model'
import { driverStatus } from '../../machine/drivers'
import { contentPath, saveImage, StoredFile } from '../../machine/files'
import { prepare } from '../../machine/launch'
import { changeRegistry, readRegistry, switchConversation } from '../../machine/registry'
import {
  createSession,
  deleteSession,
  forkSession,
  listSessions,
  newSessionConversation,
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

test('checking status when a driver exits with the probe still unread returns a stopped session', async t => {
  machine(t)
  mkdirSync(statePath('terminals'), { recursive: true })
  const listener = spawn('python3', [
    '-c',
    `import socket, sys
listener = socket.socket(socket.AF_UNIX)
listener.bind(sys.argv[1])
listener.listen(1)
print('ready', flush=True)
peer, _ = listener.accept()
peer.recv(1, socket.MSG_PEEK)
listener.close()
peer.close()`,
    statePath('terminals/closing.sock'),
  ])
  t.after(() => listener.kill())
  await once(listener.stdout, 'data', { signal: AbortSignal.timeout(5000) })
  assert.deepEqual(await driverStatus('closing'), { terminal: null, chat: null })
})

test('a creation receipt replays the session, refuses changed settings and never resurrects it', async t => {
  const { input } = setup(t)
  const key = 'a'.repeat(64)
  const request = input({ name: 'Retryable', env: { A: '1', B: '2' } })
  const first = await createSession(request, key)
  const again = await createSession({ ...request, env: { A: '1', B: '2' } }, key)
  assert.equal(again.id, first.id)
  assert.equal(again.conversation, first.conversation)
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
  // Custom session-selection arguments (e.g. --resume/--continue) are allowed and skip auto-allocation.
  const custom = await createSession(input({ name: 'Resume', args: '--resume other' }))
  assert.equal(custom.conversation, null)
  assert.deepEqual(custom.conversations, [])
})

test('an invalid registry is reported and never rewritten', async t => {
  const { input, registryBytes } = setup(t)
  await createSession(input())
  const data = JSON.parse(registryBytes().toString())
  assert.equal(data.version, 4)
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

test('model, mode and MCP servers are launch configuration; an unchanged edit keeps the revision', async t => {
  const { input } = setup(t)
  const mcpServers = {
    docs: { type: 'http' as const, url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } },
  }
  const session = await createSession(input({ model: ' opus ', mode: 'plan', mcpServers }))
  assert.deepEqual(
    { model: session.config.model, mode: session.config.mode, mcpServers: session.config.mcpServers },
    { model: 'opus', mode: 'plan', mcpServers },
  )
  const same = await updateSession(session.id, { revision: 1, model: 'opus', mcpServers, env: {} })
  assert.equal(same.config.revision, 1)
  const edited = await updateSession(session.id, { revision: 1, mode: null, mcpServers: {} })
  assert.equal(edited.config.revision, 2)
  assert.deepEqual([edited.config.mode, edited.config.mcpServers, edited.config.model], [null, {}, 'opus'])
  await assert.rejects(
    updateSession(session.id, {
      revision: 2,
      mcpServers: { big: { command: 'x', args: Array.from({ length: 10 }, () => 'a'.repeat(4000)) } },
    }),
    { status: 400, message: /32 KiB/ },
  )
})

test('switching makes an earlier conversation current, but not one that moved', async t => {
  const home = machine(t)
  const [a, b, c] = ['1', '2', '3'].map(digit => `${digit.repeat(8)}-1111-4111-8111-111111111111`)
  const session = record(home, 'claude', a)
  session.conversations.push({ id: b, tool: 'claude', startedAt: session.createdAt, movedTo: null })
  session.conversations.push({ id: c, tool: 'claude', startedAt: session.createdAt, movedTo: 'elsewhere' })
  session.conversation = b
  await register(session)
  const switched = await switchSession(session.id, a)
  assert.equal(switched.conversation, a)
  assert.deepEqual(
    switched.conversations.map(item => item.id),
    [b, c, a],
  )
  await assert.rejects(switchSession(session.id, c), /moved to another session/)
  await assert.rejects(switchSession(session.id, 'unknown'), { status: 404 })
})

test('listSessions sorts sessions most recently used first', async t => {
  const home = machine(t)
  const oldest = record(home, 'claude', '11111111-1111-4111-8111-111111111111', {
    name: 'Oldest',
    createdAt: '2026-10-01T00:00:00.000Z',
    lastConnectedAt: '2026-10-02T00:00:00.000Z',
  })
  const recentlyConnected = record(home, 'claude', '22222222-1111-4111-8111-111111111111', {
    name: 'Connected',
    createdAt: '2026-10-01T00:00:00.000Z',
    lastConnectedAt: '2026-10-05T00:00:00.000Z',
  })
  const newlyCreated = record(home, 'claude', '33333333-1111-4111-8111-111111111111', {
    name: 'Newest',
    createdAt: '2026-10-06T00:00:00.000Z',
    lastConnectedAt: null,
  })
  await register(oldest, recentlyConnected, newlyCreated)
  assert.deepEqual(
    (await listSessions()).map(session => session.name),
    ['Newest', 'Connected', 'Oldest'],
  )
})

test('a fork is a new session in a new worktree, with the source settings and a new conversation', async t => {
  const { input, home, project, git, repository } = setup(t)
  repository()
  writeFileSync(join(project, 'tracked.txt'), 'uncommitted content')
  for (const tool of ['claude', 'codex', 'kimi', 'antigravity'] as const) {
    const source = await createSession(
      input({
        name: tool,
        tool,
        env: { MODEL: 'fixture' },
        args: '--verbose',
        model: 'fixture',
        mcpServers: { tools: { command: 'tools-mcp' } },
      }),
    )
    const branch = `feature/${tool}`
    const destination = join(home, `${tool} fork's worktree`)
    const fork = await forkSession(source.id, branch, destination)
    assert.equal(fork.rootDir, destination)
    assert.equal(fork.name, branch)
    assert.equal(fork.tool, tool)
    assert.deepEqual({ ...fork.config, revision: 1 }, source.config)
    assert.deepEqual(fork.storage, source.storage)
    assert.notEqual(fork.conversation, source.conversation)
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
  assert.equal(existsSync(saved[0]), false)
  for (const image of saved.slice(-20)) {
    assert.deepEqual(readFileSync(image), data)
    assert.equal(statSync(image).mode & 0o777, 0o600)
    assert.ok(image.startsWith(directory))
  }
  for (const size of [0, 16 * 1024 * 1024 + 1])
    assert.throws(() => saveImage(session.id, 'png', Buffer.alloc(size)), { status: 413 })
  for (const extension of ['../png', 'svg', 'PNG'])
    assert.throws(() => saveImage(session.id, extension, Buffer.alloc(1)), { status: 400 })
  assert.throws(() => saveImage(crypto.randomUUID(), 'png', Buffer.alloc(1)), { status: 404 })
  await deleteSession(session.id)
  assert.equal(existsSync(directory), false, 'deleting a session removes its images')
})

test('a conversation the tool started fresh replaces the one that never started; a switch keeps the timeline', async t => {
  const home = machine(t)
  const [unused, first, second] = ['4', '5', '6'].map(digit => `${digit.repeat(8)}-1111-4111-8111-111111111111`)
  const session = record(home, 'claude', unused)
  await register(session)
  await changeRegistry(registry => switchConversation(registry, session.id, first, true))
  await changeRegistry(registry => switchConversation(registry, session.id, second))
  assert.deepEqual(
    readRegistry().sessions[0].conversations.map(item => item.id),
    [first, second],
  )
})

test('an attached viewer reads bounded file ranges scoped to its own session', async t => {
  const { home } = setup(t)
  const owner = record(home, 'codex', crypto.randomUUID())
  const other = record(home, 'codex', crypto.randomUUID())
  await register(owner, other)
  const { publish, readFileChunk } = await import('../../machine/files')
  const bytes = Buffer.alloc(65539, 0x2d)
  const path = join(home, 'report.bin')
  writeFileSync(path, bytes)
  const file = await publish(owner.id, path)
  assert.deepEqual(await readFileChunk(owner.id, file.id, 0), bytes.subarray(0, 65536))
  assert.deepEqual(await readFileChunk(owner.id, file.id, 65536), bytes.subarray(65536))
  await assert.rejects(readFileChunk(other.id, file.id, 0), /not found/)
  await assert.rejects(readFileChunk(owner.id, file.id, bytes.length + 1), /offset/)
})

test('finishing one file transfer leaves a concurrent transfer writable', async t => {
  const home = machine(t)
  const session = record(home, 'codex', crypto.randomUUID())
  await register(session)
  const first = new StoredFile(session.id, 'first.txt', 'received')
  first.write(Buffer.from('one'))
  const committing = first.commit()
  await Promise.resolve()
  const second = new StoredFile(session.id, 'second.txt', 'received')
  const saved = await committing
  first.abort()
  second.write(Buffer.from('two'))
  const next = await second.commit()
  assert.equal(readFileSync(contentPath(session.id, saved), 'utf8'), 'one')
  assert.equal(readFileSync(contentPath(session.id, next), 'utf8'), 'two')
})

test('image chunks stay with their attachment and an interrupted upload cannot finish on a new one', async t => {
  const { home } = setup(t)
  const session = record(home, 'codex', crypto.randomUUID())
  await register(session)
  const { TerminalImages } = await import('../../machine/terminalImages')
  const viewer = new TerminalImages()
  const replacement = new TerminalImages()
  try {
    const image = Buffer.alloc(65539, 0xf3)
    Buffer.from('89504e470d0a1a0a', 'hex').copy(image)
    const start = {
      type: 'image-write' as const,
      id: 'first',
      transfer: 'test',
      mime: 'image/png',
      size: image.length,
      offset: 0,
      chunk: image.subarray(0, 65536).toString('base64'),
    }
    const end = { ...start, id: 'last', offset: 65536, chunk: image.subarray(65536).toString('base64') }
    assert.equal(viewer.write(start), undefined)
    assert.throws(() => replacement.write(end), /transfer changed/)
    viewer.write(end)
    await assert.rejects(
      replacement.paste('test', () => assert.fail()),
      /incomplete/,
    )
    await viewer.paste('test', value => assert.deepEqual(value.bytes, image))
    await assert.rejects(
      viewer.paste('test', () => assert.fail()),
      /incomplete/,
    )
    viewer.write(start)
    viewer.close()
    assert.throws(() => viewer.write(end), /transfer changed/)
  } finally {
    viewer.close()
    replacement.close()
  }
})

test('deleting a session reconciles movedTo pointers and restores ownership without duplicates', async t => {
  const { input } = setup(t)
  const first = await createSession(input({ name: 'First' }))
  const second = await createSession(input({ name: 'Second' }))
  const third = await createSession(input({ name: 'Third' }))
  const movedId = first.conversation!

  // Move conversation: First -> Second -> Third.
  await changeRegistry(registry => {
    switchConversation(registry, second.id, movedId)
    switchConversation(registry, third.id, movedId)
  })
  // Deleting middle session Second while Third still holds movedId must re-point First -> Third.
  await deleteSession(second.id)
  const afterMidDelete = readRegistry().sessions.find(s => s.id === first.id)!
  assert.equal(afterMidDelete.conversations.at(-1)!.movedTo, third.id)

  // Deleting active holder Third restores movedId to First (movedTo becomes null).
  await deleteSession(third.id)
  const restored = readRegistry().sessions.find(s => s.id === first.id)!
  assert.equal(restored.conversations.at(-1)!.movedTo, null)
})

test('reclaim moves a conversation back from a stopped session, and newSessionConversation unsticks a stranded session', async t => {
  const { input } = setup(t)
  const source = await createSession(input({ name: 'Source' }))
  const thief = await createSession(input({ name: 'Thief' }))
  const original = source.conversation!

  // Move Source's only conversation to Thief.
  await changeRegistry(registry => {
    switchConversation(registry, thief.id, original)
  })
  assert.equal(
    readRegistry()
      .sessions.find(s => s.id === source.id)!
      .conversations.at(-1)!.movedTo,
    thief.id,
  )

  // Plain switch refuses a moved conversation, while reclaim moves it back.
  await assert.rejects(switchSession(source.id, original), /moved to another session/)
  const reclaimed = await switchSession(source.id, original, { reclaim: true })
  assert.equal(reclaimed.conversations.at(-1)!.id, original)
  assert.equal(reclaimed.conversations.at(-1)!.movedTo, null)
  assert.equal(
    readRegistry()
      .sessions.find(s => s.id === thief.id)!
      .conversations.at(-1)!.movedTo,
    source.id,
  )

  // Thief is now stranded on movedTo; newSessionConversation allocates a fresh active conversation.
  const fresh = await newSessionConversation(thief.id)
  assert.equal(fresh.conversations.at(-1)!.movedTo, null)
  assert.notEqual(fresh.conversations.at(-1)!.id, original)
})

test('editing harness, directory, and conversation ID preserves per-harness history and bumps revision', async t => {
  const { home, input } = setup(t)
  const otherDir = join(home, 'other-project')
  mkdirSync(otherDir)

  const created = await createSession(input({ name: 'Flexible', tool: 'claude' }))
  const claudeId = created.conversation!
  assert.equal(created.tool, 'claude')
  assert.equal(created.config.revision, 1)
  assert.equal('title' in created, false)

  // Switch harness claude -> codex: storage updates, claude conversation is remembered, codex starts fresh.
  const asCodex = await updateSession(created.id, { revision: 1, tool: 'codex' })
  assert.equal(asCodex.tool, 'codex')
  assert.equal(asCodex.config.revision, 2)
  assert.ok('CODEX_HOME' in asCodex.storage)
  assert.equal(asCodex.conversation, null)
  assert.deepEqual(
    asCodex.conversations.map(c => [c.tool, c.id]),
    [['claude', claudeId]],
  )

  // Starting a fresh session with no custom selection flag auto-allocates and remembers a codex conversation.
  const codexRecord = readRegistry().sessions.find(s => s.id === created.id)!
  const preparedCodex = await prepare(codexRecord, 'terminal')
  const codexId = preparedCodex.launch.conversation
  assert.ok(codexId)
  assert.equal(readRegistry().sessions.find(s => s.id === created.id)!.conversation, codexId)

  // Switch harness codex -> kimi with an explicit conversation ID, and change rootDir.
  const kimiId = 'session_manual_123'
  const asKimi = await updateSession(created.id, {
    revision: 2,
    tool: 'kimi',
    rootDir: otherDir,
    conversation: kimiId,
  })
  assert.equal(asKimi.tool, 'kimi')
  assert.equal(asKimi.rootDir, otherDir)
  assert.equal(asKimi.conversation, kimiId)
  assert.equal(asKimi.config.revision, 3)
  assert.ok('KIMI_CODE_HOME' in asKimi.storage)

  // Invalid conversation ID for the selected harness is refused.
  await assert.rejects(updateSession(created.id, { revision: 3, conversation: 'not-a-kimi-id' }), {
    status: 400,
    message: /Invalid conversation ID/,
  })
  // Nonexistent rootDir is refused.
  await assert.rejects(updateSession(created.id, { revision: 3, rootDir: join(home, 'missing') }), {
    status: 400,
    message: /Root directory does not exist/,
  })

  // Switching back to claude automatically restores the remembered claude conversation ID!
  const backToClaude = await updateSession(created.id, { revision: 3, tool: 'claude' })
  assert.equal(backToClaude.tool, 'claude')
  assert.equal(backToClaude.conversation, claudeId)
  assert.equal(backToClaude.config.revision, 4)

  // Clearing conversation to null + passing --continue in args skips auto-allocation on prepare().
  const manualContinue = await updateSession(created.id, {
    revision: 4,
    conversation: null,
    args: '--continue',
  })
  assert.equal(manualContinue.conversation, null)
  assert.equal(manualContinue.config.revision, 5)
  const preparedManual = await prepare(
    readRegistry().sessions.find(s => s.id === created.id)!,
    'terminal',
  )
  assert.equal(preparedManual.launch.conversation, '')

  // Switching via Conversations dialog across harnesses switches the session back to that harness.
  const switchedToKimi = await switchSession(created.id, kimiId)
  assert.equal(switchedToKimi.tool, 'kimi')
  assert.equal(switchedToKimi.conversation, kimiId)

  // Start-command preview accurately reflects harness, conversation, and custom flags.
  assert.equal(argsSelectSession('claude', '--continue'), true)
  assert.equal(argsSelectSession('codex', 'resume 123'), true)
  assert.equal(argsSelectSession('codex', '--full-auto'), false)
  assert.match(
    previewStartCommand('codex', { instructions: null, model: 'o3', args: '--full-auto' }, codexId).command,
    new RegExp(`codex.*resume ${codexId}.*--full-auto`),
  )
  assert.equal(
    previewStartCommand('claude', { instructions: null, model: null, args: '--continue' }, null).command,
    'claude --continue',
  )
})
