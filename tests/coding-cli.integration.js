import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { SessionClient } from '../backend/sessions.ts'
import { quote } from '../backend/shell.ts'

const execute = promisify(execFile)
const target = { kind: 'local', id: 'native-coding', name: 'Native coding', tools: ['codex', 'kimi', 'claude'], backends: ['tmux'], createdAt: '2026-09-30T00:00:00Z' }
for (const tool of target.tools) test(`real ${tool}: native ID, cold resume, completion, acknowledgement, and target-side discovery`, { skip: process.platform === 'win32', timeout: 90_000 }, async t => {
  let executable
  try { executable = process.env[`OUTPOST_${tool.toUpperCase()}_BINARY`] || (await execute('sh', ['-c', `command -v ${tool}`])).stdout.trim() }
  catch (error) {
    if (process.env.OUTPOST_REQUIRE_CODING_TOOLS === '1') throw error
    t.skip(`${tool} is not installed on this test computer`); return
  }
  const home = await mkdtemp(join(tmpdir(), `outpost-native-${tool}-`))
  const root = join(home, 'project')
  const bin = join(home, 'bin')
  await mkdir(root); await mkdir(bin)
  await writeFile(join(bin, tool), `#!/bin/sh\nexec ${quote(executable)} "$@"\n`, { mode: 0o700 })
  await writeFile(join(home, '.bash_profile'), `export PATH=${quote(bin)}:"$PATH"\n`)
  const modelCalls = []
  let failModel = false
  const model = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    if (failModel && request.method === 'POST') {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'OUTPOST_FIXTURE_ERROR' } }))
      return
    }
    if (request.method === 'POST' && request.url.startsWith('/v1/messages')) {
      modelCalls.push(JSON.parse(body))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      send('message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'NATIVE_ASSISTANT_SEARCH_FIXTURE' } })
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
      send('message_stop', { type: 'message_stop' })
      response.end()
    } else if (request.method === 'POST' && request.url.startsWith('/v1/chat/completions')) {
      modelCalls.push(JSON.parse(body))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', model: 'fixture', created: 1,
        choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      send({ role: 'assistant', content: '' })
      send({ content: 'NATIVE_ASSISTANT_SEARCH_FIXTURE' })
      send({}, 'stop')
      response.end('data: [DONE]\n\n')
    } else if (request.method === 'POST' && request.url.startsWith('/v1/responses')) {
      modelCalls.push(JSON.parse(body))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'NATIVE_ASSISTANT_SEARCH_FIXTURE', annotations: [] }] }
      send('response.created', { response: { id: 'resp_fixture', status: 'in_progress', model: 'fixture', output: [] } })
      send('response.output_item.added', { output_index: 0, item: { ...item, content: [], status: 'in_progress' } })
      send('response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '' } })
      send('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: 'NATIVE_ASSISTANT_SEARCH_FIXTURE' })
      send('response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text: 'NATIVE_ASSISTANT_SEARCH_FIXTURE' })
      send('response.output_item.done', { output_index: 0, item })
      send('response.completed', { response: { id: 'resp_fixture', status: 'completed', model: 'fixture', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
      response.end()
    } else { response.writeHead(404); response.end('{}') }
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  t.after(async () => { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await rm(home, { recursive: true, force: true }) })
  const endpoint = `http://127.0.0.1:${model.address().port}`
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'), KIMI_CODE_HOME: join(home, '.kimi-code'),
    ANTHROPIC_API_KEY: 'test-token', ANTHROPIC_BASE_URL: endpoint, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', OPENAI_API_KEY: 'test-token' }
  if (tool === 'codex') {
    await mkdir(env.CODEX_HOME)
    await writeFile(join(env.CODEX_HOME, 'config.toml'), `model = "fixture"\nmodel_provider = "fixture"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.fixture]\nname = "fixture"\nbase_url = "${endpoint}/v1"\nwire_api = "responses"\nenv_key = "OPENAI_API_KEY"\nrequest_max_retries = 0\nstream_max_retries = 0\nsupports_websockets = false\n`)
  } else if (tool === 'kimi') {
    await mkdir(env.KIMI_CODE_HOME)
    await writeFile(join(env.KIMI_CODE_HOME, 'config.toml'), `defaultModel = "fixture"\n[models.fixture]\nname = "fixture"\nprotocol = "openai"\nbaseUrl = "${endpoint}/v1"\napiKey = "test-token"\nmaxContextSize = 8192\n`)
  }
  const service = new SessionClient(env)
  const session = await service.create(target, { name: tool, tool, backend: 'tmux', rootDir: root })
  assert.ok(session.cliSessionId)
  assert.notEqual(session.cliSessionId, session.id)
  if (tool === 'codex') {
    const directory = join(env.CODEX_HOME, 'sessions', ...new Date().toISOString().slice(0, 10).split('-'))
    const name = (await readdir(directory)).find(name => name.endsWith(session.cliSessionId + '.jsonl'))
    const metadata = JSON.parse((await readFile(join(directory, name), 'utf8')).trim()).payload
    assert.equal(metadata.model_provider, 'fixture', 'new metadata uses the configured provider on a fresh install')
  }
  if (tool === 'claude') {
    const run = args => execute(executable, [...args, '--bare', '--model', 'sonnet', '-p', 'NATIVE_USER_SEARCH_FIXTURE'], { cwd: root, env, timeout: 30_000 })
    assert.match((await run(['--session-id', session.cliSessionId])).stdout, /NATIVE_ASSISTANT_SEARCH_FIXTURE/)
    const firstCompletion = (await service.get(target, session.id)).activity
    assert.equal(firstCompletion.state, 'finished', 'the actual persisted native stop reason marks a finished turn')
    assert.equal((await service.acknowledge(target, session.id, firstCompletion.completionId)).activity.state, 'idle')
    assert.match((await run(['--resume', session.cliSessionId])).stdout, /NATIVE_ASSISTANT_SEARCH_FIXTURE/)
    const secondCompletion = (await service.get(target, session.id)).activity
    assert.equal(secondCompletion.state, 'finished')
    assert.notEqual(secondCompletion.completionId, firstCompletion.completionId)
    assert.equal((await service.acknowledge(target, session.id, firstCompletion.completionId)).activity.state, 'finished')
    const found = await service.search(target, { query: 'NATIVE_ASSISTANT_SEARCH_FIXTURE', tool })
    assert.equal(found.sessions.length, 1)
    assert.equal(found.sessions[0].cliSessionId, session.cliSessionId)
    assert.deepEqual(found.sessions[0].managedSessionIds, [session.id])
    assert.equal((await service.search(target, { query: 'NATIVE_USER_SEARCH_FIXTURE', tool })).sessions[0].cliSessionId, session.cliSessionId)
  } else {
    const protocol = fileURLToPath(new URL('./fixtures/native-coding-protocol.py', import.meta.url))
    assert.match((await execute('python3', [protocol, tool, executable, session.cliSessionId, root], { env, timeout: 30_000 })).stdout, /NATIVE_RESUME_OK/)
    const found = await service.search(target, { query: session.cliSessionId, tool })
    assert.equal(found.sessions[0].cliSessionId, session.cliSessionId)
    assert.deepEqual(found.sessions[0].managedSessionIds, [session.id])
    assert.equal(modelCalls.length, 0, 'initialization and cold resume never submit a model request')
    assert.match((await execute('python3', [protocol, tool, executable, session.cliSessionId, root, 'turn'], { env, timeout: 30_000 })).stdout, /NATIVE_TURN_OK/)
    assert.ok(modelCalls.length > 0, 'the turn uses only the loopback model fixture')
    const completion = (await service.get(target, session.id)).activity
    assert.equal(completion.state, 'finished', 'actual native turn completion creates an unread notice')
    assert.equal((await service.acknowledge(target, session.id, completion.completionId)).activity.state, 'idle')
  }
  assert.equal((await service.get(target, session.id)).cliSessionId, session.cliSessionId)
  failModel = true
  const failed = tool === 'claude'
    ? execute(executable, ['--resume', session.cliSessionId, '--bare', '--model', 'sonnet', '-p', 'NATIVE_USER_SEARCH_FIXTURE'], { cwd: root, env, timeout: 30_000 })
    : execute('python3', [fileURLToPath(new URL('./fixtures/native-coding-protocol.py', import.meta.url)), tool, executable, session.cliSessionId, root, 'turn'], { env, timeout: 30_000 })
  if (tool === 'kimi') await failed  // ACP returns end_turn even when its native turn log records an error.
  else await assert.rejects(failed)
  assert.equal((await service.get(target, session.id)).activity.state, 'idle', 'a real provider failure is not a successfully finished turn')
  const registry = await readFile(join(home, '.outpost', 'sessions.json'), 'utf8')
  assert.equal(registry.includes('NATIVE_ASSISTANT_SEARCH_FIXTURE'), false)
})
