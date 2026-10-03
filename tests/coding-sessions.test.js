import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile, appendFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SessionClient } from '../backend/sessions.ts'
import { quote } from '../backend/shell.ts'

const target = { kind: 'local', id: 'coding', name: 'Coding', backends: ['tmux', 'dtach'], tools: ['codex', 'kimi', 'claude'], createdAt: '2026-09-30T00:00:00Z' }
const fixtureSource = new URL('./fixtures/coding-tool-fixture.py', import.meta.url)
const jsonl = records => records.map(record => JSON.stringify(record)).join('\n') + '\n'
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'outpost-coding-'))
  const bin = join(home, 'bin')
  const root = join(home, "project 'quotes' é")
  await mkdir(bin); await mkdir(root)
  for (const tool of target.tools) await writeFile(join(bin, tool), await readFile(fixtureSource), { mode: 0o700 })
  await writeFile(join(home, '.bash_profile'), `export PATH=${quote(bin)}:"$PATH"\n`)
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'), KIMI_CODE_HOME: join(home, '.kimi-code') }
  t.after(() => rm(home, { recursive: true, force: true }))
  const service = new SessionClient(env)
  const put = async (path, content) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, content) }
  return { home, root, env, service, put }
}

test('search reads all three CLI stores on the target, including tool output, reasoning, Unicode, and subagents', { skip: process.platform === 'win32' }, async t => {
  const { home, root, env, service, put } = await fixture(t)
  const ids = { codex: randomUUID(), claude: randomUUID(), kimi: 'session_search_fixture' }
  const needle = 'Needle 项目 [literal].*'
  await put(join(env.CODEX_HOME, 'sessions/2026/09/30', `rollout-fixture-${ids.codex}.jsonl`), jsonl([
    { type: 'session_meta', payload: { id: ids.codex, cwd: root, timestamp: '2026-09-30T01:00:00Z' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call', output: `Earlier tool output: ${needle}` } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,HIDDEN_IMAGE_KEYWORD' }] } },
  ]))
  await put(join(env.CODEX_HOME, 'session_index.jsonl'), jsonl([{ id: ids.codex, thread_name: 'Auth investigation' }]))
  await put(join(env.CLAUDE_CONFIG_DIR, 'projects', 'project', ids.claude + '.jsonl'), jsonl([
    { type: 'user', cwd: root, sessionId: ids.claude, timestamp: '2026-09-30T02:00:00Z', message: { content: 'Initial request' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: `Reasoning with ${needle}` }] } },
    { type: 'assistant', message: null },
  ]) + '{"type":"user","message":')
  await put(join(env.CLAUDE_CONFIG_DIR, 'projects', 'project', ids.claude, 'subagents/agent-fixture.jsonl'), jsonl([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'CLAUDE_SUBAGENT_ONLY_KEYWORD' }] } },
  ]))
  const kimi = join(env.KIMI_CODE_HOME, 'sessions', 'bucket', ids.kimi)
  await put(join(env.KIMI_CODE_HOME, 'session_index.jsonl'), jsonl([{ sessionId: ids.kimi, workDir: root }]))
  await put(join(kimi, 'state.json'), JSON.stringify({ title: 'Parser work', createdAt: 1790730000000, updatedAt: 1790735000000 }, null, 2))
  await put(join(kimi, 'agents/main/wire.jsonl'), jsonl([{ type: 'context.append_message', agentId: 'main', message: { role: 'assistant', content: [{ type: 'text', text: `Response with ${needle}` }] } }]))
  await put(join(kimi, 'agents/agent-1/wire.jsonl'), jsonl([{ type: 'context.append_loop_event', event: { type: 'tool.result', content: { data: 'SUBAGENT_ONLY_KEYWORD' } } }]))
  const result = await service.search(target, { query: needle.toLowerCase() })
  assert.equal(result.sessions.length, 3)
  assert.deepEqual(new Set(result.sessions.map(session => session.cliSessionId)), new Set(Object.values(ids)))
  for (const session of result.sessions) {
    assert.equal(session.rootDir, root)
    assert.ok(session.excerpt.includes(needle))
    assert.deepEqual(session.managedSessionIds, [])
    assert.ok(session.excerpt.length <= 280)
    assert.equal(session.history, undefined)
  }
  assert.equal(result.truncated, false)
  assert.ok((await service.search(target, { query: 'no_match_anywhere' })).warnings.some(warning => warning.includes('incomplete')))
  assert.deepEqual((await service.search(target, { query: 'subagent_only_keyword', tool: 'kimi' })).sessions.map(session => session.cliSessionId), [ids.kimi])
  assert.deepEqual((await service.search(target, { query: 'CLAUDE_SUBAGENT_ONLY_KEYWORD', tool: 'claude' })).sessions.map(session => session.cliSessionId), [ids.claude])
  assert.equal((await service.search(target, { query: 'HIDDEN_IMAGE_KEYWORD' })).sessions.length, 0)
  assert.equal((await service.search(target, { query: 'Auth investigation' })).sessions[0].cliSessionId, ids.codex)
  assert.ok(!(await readdir(home)).includes('.outpost'), 'search never initializes a manager registry or local index')
})

test('a fresh target stays untouched, queries are literal, search is live, and escaping symlinks are ignored', { skip: process.platform === 'win32' }, async t => {
  const { home, root, env, service, put } = await fixture(t)
  assert.deepEqual(await service.search(target, { query: 'nothing' }), { sessions: [], truncated: false, warnings: [] })
  const id = randomUUID()
  const path = join(env.CODEX_HOME, 'sessions', '2026', `rollout-live-${id}.jsonl`)
  await put(path, jsonl([{ type: 'session_meta', payload: { id, cwd: root } }]))
  assert.equal((await service.search(target, { query: 'new words' })).sessions.length, 0)
  await appendFile(path, jsonl([{ type: 'response_item', payload: { type: 'message', role: 'user', content: 'Brand NEW WORDS appear live' } }]))
  assert.equal((await service.search(target, { query: 'new words' })).sessions.length, 1)
  const malicious = `$(touch ${join(home, 'INJECTED')}) ; [.*] 'quote'`
  await appendFile(path, jsonl([{ type: 'response_item', payload: { type: 'function_call_output', output: malicious } }]))
  assert.equal((await service.search(target, { query: malicious })).sessions.length, 1)
  assert.ok(!(await readdir(home)).includes('INJECTED'))
  const external = join(home, 'external')
  await put(join(external, 'rollout-private.jsonl'), jsonl([{ type: 'session_meta', payload: { id: randomUUID(), cwd: root } }, { type: 'response_item', payload: { content: 'SECRET_EXTERNAL_KEYWORD' } }]))
  await symlink(external, join(env.CODEX_HOME, 'sessions', 'escape'), 'dir')
  await symlink(join(external, 'rollout-private.jsonl'), join(env.CODEX_HOME, 'sessions', 'rollout-symlink.jsonl'))
  assert.equal((await service.search(target, { query: 'SECRET_EXTERNAL_KEYWORD' })).sessions.length, 0)
  for (const query of ['', ' ', 'x'.repeat(257), 'new\nwords']) await assert.rejects(service.search(target, { query }), /keyword/)
})

test('new and imported sessions have native IDs, preserve storage scope, prevent duplicate links, and keep conversation content out of the registry', { skip: process.platform === 'win32' }, async t => {
  const { home, root, env, service, put } = await fixture(t)
  for (const tool of target.tools) {
    const created = await service.create(target, { name: tool, tool, backend: 'tmux', rootDir: root })
    assert.ok(created.cliSessionId)
    assert.notEqual(created.cliSessionId, created.id)
    assert.equal(created.status, 'idle')
    assert.ok(Object.values(created.cliSessionEnv).every(path => path.startsWith(home)))
  }
  const cliSessionId = randomUUID()
  const claudeHome = join(home, 'custom claude store')
  const history = join(claudeHome, 'projects', 'project', cliSessionId + '.jsonl')
  await put(history, jsonl([{ type: 'user', cwd: root, message: { content: 'PRIVATE_CONVERSATION_CONTENT' } }]))
  const input = { name: 'Imported Claude', tool: 'claude', backend: 'dtach', rootDir: root, cliSessionId, cliSessionEnv: { CLAUDE_CONFIG_DIR: claudeHome } }
  const previousMode = (await stat(history)).mode
  const linked = await service.create(target, input)
  assert.equal(linked.cliSessionId, cliSessionId)
  assert.deepEqual(linked.cliSessionEnv, input.cliSessionEnv)
  const found = await service.search(target, { query: 'PRIVATE_CONVERSATION_CONTENT' })
  assert.equal(found.sessions.length, 1)
  assert.deepEqual(found.sessions[0].managedSessionIds, [linked.id])
  await assert.rejects(service.create(target, { ...input, name: 'Duplicate', backend: 'tmux' }), /already has a manager session/)
  await assert.rejects(service.create(target, { ...input, name: 'Wrong root', rootDir: home }), /working directory/)
  await assert.rejects(service.create(target, { ...input, name: 'Missing', cliSessionId: randomUUID() }), /not found/)
  const saved = JSON.parse(await readFile(join(home, '.outpost', 'sessions.json'), 'utf8'))
  assert.equal(JSON.stringify(saved).includes('PRIVATE_CONVERSATION_CONTENT'), false)
  assert.equal((await stat(history)).mode, previousMode, 'reading and linking preserves the CLI-owned file permissions')
  assert.equal((await stat(join(env.CODEX_HOME, 'sessions', ...new Date().toISOString().slice(0, 10).split('-')))).isDirectory(), true)
  assert.equal((await new SessionClient(env).get(target, linked.id)).cliSessionId, cliSessionId)
  await service.remove(target, linked.id)
  assert.equal(await readFile(history, 'utf8'), jsonl([{ type: 'user', cwd: root, message: { content: 'PRIVATE_CONVERSATION_CONTENT' } }]))
})

test('broad searches are bounded and mark partial results, while malformed neighboring sessions do not hide valid matches', { skip: process.platform === 'win32' }, async t => {
  const { root, env, service, put } = await fixture(t)
  for (let index = 0; index < 61; index++) {
    await put(join(env.CLAUDE_CONFIG_DIR, 'projects', 'project', randomUUID() + '.jsonl'), jsonl([
      { type: 'user', cwd: root, message: { content: `common_keyword result ${index}` } },
    ]))
  }
  await put(join(env.CLAUDE_CONFIG_DIR, 'projects', 'project', randomUUID() + '.jsonl'), jsonl([{ type: 'user', message: null }]))
  await put(join(env.CLAUDE_CONFIG_DIR, 'projects', 'project', randomUUID() + '.jsonl'), jsonl([
    { type: 'user', cwd: root, message: { content: { type: [], text: 'common_keyword malformed content type' } } },
  ]) + '{"type":"user","message":{"content":' + '['.repeat(1200) + '"too deep"' + ']'.repeat(1200) + '}}\n')
  const result = await service.search(target, { query: 'common_keyword' })
  assert.equal(result.sessions.length, 50)
  assert.equal(result.truncated, true)
  assert.ok(JSON.stringify(result).length < 64 * 1024)
})

test('fresh Codex allocation resolves a real provider and template selection isolates the new conversation', { skip: process.platform === 'win32' }, async t => {
  const { root, env, service, put, home } = await fixture(t)
  const readMeta = async session => {
    const date = new Date().toISOString().slice(0, 10).split('-')
    const directory = join(env.CODEX_HOME, 'sessions', ...date)
    const name = (await readdir(directory)).find(name => name.endsWith(session.cliSessionId + '.jsonl'))
    const records = (await readFile(join(directory, name), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(records.length, 1, 'allocation does not copy conversation turns')
    return records[0].payload
  }
  const fresh = await service.create(target, { name: 'Fresh', tool: 'codex', backend: 'tmux', rootDir: root })
  assert.equal((await readMeta(fresh)).model_provider, 'fixture', 'a fresh store never reserves an empty provider')
  const templateId = randomUUID()
  const metadata = { id: templateId, source: 'cli', cwd: '/old-project', originator: 'codex_cli', cli_version: 'old-build', model_provider: 'fixture',
    runtime_workspace_roots: ['/old-project'], context_window: { window_id: randomUUID(), window_ordinal: 0 }, build_specific: 'native-shape',
    base_instructions: { text: 'PRIVATE_OLD_INSTRUCTIONS' }, git: { commit_hash: 'old-checkout' },
    history_base: { thread_id: templateId }, parent_thread_id: templateId, forked_from_id: templateId, agent_role: 'old-subagent' }
  const template = join(env.CODEX_HOME, 'sessions', `rollout-template-${templateId}.jsonl`)
  await put(template, jsonl([{ type: 'session_meta', payload: metadata }, { type: 'response_item', payload: { content: 'PRIVATE_OLD_CONVERSATION' } }]))
  await utimes(template, new Date('2026-01-01'), new Date('2026-01-01'))
  for (let index = 0; index < 22; index++) {
    await put(join(env.CODEX_HOME, 'sessions', `rollout-manager-${index}.jsonl`), jsonl([{ type: 'session_meta', payload: { ...metadata, id: randomUUID(), originator: 'outpost' } }]))
  }
  await put(join(env.CODEX_HOME, 'sessions', 'rollout-malformed.jsonl'), '[]\n')
  await put(join(env.CODEX_HOME, 'sessions', 'rollout-null.jsonl'), 'null\n')
  await put(join(env.CODEX_HOME, 'sessions', 'rollout-payload.jsonl'), jsonl([{ type: 'session_meta', payload: [] }]))
  await put(join(env.CODEX_HOME, 'sessions', 'rollout-deep.jsonl'), '['.repeat(1200) + '0' + ']'.repeat(1200) + '\n')
  await put(join(env.CODEX_HOME, 'sessions', 'rollout-partial.jsonl'), '{"type":"session_meta"')
  await put(join(env.CODEX_HOME, 'sessions', 'rollout-oversized.jsonl'), 'x'.repeat(128 * 1024 + 1) + '\n')
  await put(join(env.CODEX_HOME, 'sessions', 'rollout-obsolete.jsonl'), jsonl([{ type: 'session_meta', payload: { ...metadata, model_provider: 'deleted-provider', build_specific: 'wrong-provider' } }]))
  await put(join(env.CODEX_HOME, 'sessions', 'rollout-subagent.jsonl'), jsonl([{ type: 'session_meta', payload: { ...metadata, source: { subagent: 'spawn' }, build_specific: 'wrong-agent' } }]))
  const outside = join(home, 'outside.jsonl')
  await put(outside, jsonl([{ type: 'session_meta', payload: { ...metadata, build_specific: 'outside-store' } }]))
  await symlink(outside, join(env.CODEX_HOME, 'sessions', 'rollout-escape.jsonl'))
  await symlink(join(home, 'missing'), join(env.CODEX_HOME, 'sessions', 'rollout-broken.jsonl'))
  const next = await service.create(target, { name: 'Template', tool: 'codex', backend: 'tmux', rootDir: root })
  const meta = await readMeta(next)
  assert.equal(meta.build_specific, 'native-shape', 'manager-created or malformed neighbors do not crowd out a real template')
  assert.equal(meta.id, next.cliSessionId)
  assert.equal(meta.session_id, next.cliSessionId)
  assert.equal(meta.model_provider, 'fixture')
  assert.equal(meta.cli_version, '0.159.2-fixture')
  assert.equal(meta.cwd, root)
  assert.deepEqual(meta.runtime_workspace_roots, [root])
  assert.notEqual(meta.context_window.window_id, metadata.context_window.window_id)
  assert.equal(meta.base_instructions, null)
  for (const field of ['git', 'history_base', 'parent_thread_id', 'forked_from_id', 'agent_role']) assert.equal(meta[field], undefined)
  assert.equal(JSON.stringify(meta).includes('PRIVATE_OLD_'), false)
  assert.equal((await readFile(join(home, '.outpost/sessions.json'), 'utf8')).includes('PRIVATE_OLD_'), false)
})
