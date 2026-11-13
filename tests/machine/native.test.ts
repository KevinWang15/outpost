// The real coding tools' hooks and transcripts drive a session's activity. Only
// the model is faked, by a loopback provider. Opt in with OUTPOST_TEST_NATIVE_ACTIVITY=1.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { HarnessId } from '../../shared/harnesses'
import { FrameDecoder, terminalControl } from '../../shared/node/terminalFrames'
import { TerminalActivity } from '../../machine/activity'
import { harness } from '../../machine/harnesses'
import { toml } from '../../machine/harnesses/codex'
import { prepare, terminalSocket, which } from '../../machine/launch'
import { JsonRpcProcess } from '../../machine/rpc'
import { socketAddress, statePath } from '../../machine/state'
import { machine, record, register } from './fixtures'

const enabled = process.env.OUTPOST_TEST_NATIVE_ACTIVITY === '1'
const binary = fileURLToPath(
  new URL(`../../machine/dist/outpost-terminal-linux-${process.arch}-glibc`, import.meta.url),
)
const until = async (check: () => boolean, label: string, timeout = 15_000) => {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** A model API that answers "done" once released, or fails with 401. */
async function provider(t: TestContext) {
  let requested = false
  let release: () => void = () => {}
  const released = new Promise<void>(resolve => (release = resolve))
  const state = { fail: false }
  const server = createHttpServer(async (request, response) => {
    await new Promise(resolve => request.on('end', resolve).resume())
    if (request.url?.split('?')[0].endsWith('/count_tokens')) return response.end('{"input_tokens":1}')
    requested = true
    await Promise.race([released, new Promise(resolve => setTimeout(resolve, 10_000))])
    if (state.fail) {
      response.writeHead(401, { 'content-type': 'application/json' })
      return response.end('{"type":"error","error":{"type":"authentication_error","message":"fixture failure"}}')
    }
    const usage = { input_tokens: 1, output_tokens: 1 }
    let events: Record<string, unknown>[]
    if (request.url!.includes('/messages'))
      events = [
        {
          type: 'message_start',
          message: {
            id: 'msg',
            type: 'message',
            role: 'assistant',
            model: 'test',
            content: [],
            stop_reason: null,
            usage,
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]
    else if (request.url!.includes('/responses'))
      events = [
        { type: 'response.created', response: { id: 'resp' } },
        {
          type: 'response.output_item.done',
          item: { id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
        },
        { type: 'response.completed', response: { id: 'resp', usage: { ...usage, total_tokens: 2 } } },
      ]
    else
      events = [
        {
          id: 'chat',
          object: 'chat.completion.chunk',
          model: 'fake',
          created: 1,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }],
        },
        {
          id: 'chat',
          object: 'chat.completion.chunk',
          model: 'fake',
          created: 1,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
      ]
    let body = events
      .map(event => `${'type' in event ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`)
      .join('')
    if (request.url!.includes('/chat/completions')) body += 'data: [DONE]\n\n'
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    release()
    server.closeAllConnections()
    server.close()
  })
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}`, requested: () => requested, release, state }
}

/** A session of the real `tool`, with the hooks reaching its activity through
 * the terminal service's socket, as in a running session. */
async function session(t: TestContext, tool: HarnessId, conversation: string) {
  if (!which(harness(tool).command)) return null
  const home = machine(t)
  mkdirSync(statePath('bin'), { recursive: true })
  copyFileSync(binary, statePath('bin', 'outpost-terminal'))
  chmodSync(statePath('bin', 'outpost-terminal'), 0o700)
  const root = join(home, "project ' activity")
  mkdirSync(root)
  const created = record(home, tool, conversation, { rootDir: root })
  mkdirSync(Object.values(created.storage)[0], { recursive: true })
  await register(created)
  const { adapter, launch } = prepare(created, 'terminal')
  launch.environment.HOME = home
  const activity = new TerminalActivity(created, conversation, adapter, () => {})
  const events: string[] = []
  mkdirSync(statePath('terminals'), { recursive: true })
  const server: Server = createServer(socket => {
    const decoder = new FrameDecoder()
    socket.on('data', (bytes: Buffer) => {
      for (const frame of decoder.feed(bytes)) {
        const message = JSON.parse(frame.payload.toString())
        if (message.type === 'hook') {
          events.push(message.payload.hook_event_name)
          void activity.hookEvent(message.payload)
        }
        socket.end(terminalControl({ type: 'result', ok: true }))
      }
    })
  })
  await new Promise<void>(resolve => server.listen(socketAddress(terminalSocket(created.id)), resolve))
  t.after(() => {
    activity.exited()
    server.close()
  })
  const state = async (expected: string) => {
    await until(() => (activity.refresh(), activity.current.state === expected), `${tool} ${expected}`).catch(error => {
      throw new Error(`${error.message}; was ${JSON.stringify(activity.current)}; hooks ${events.join(', ')}`)
    })
    return activity.current
  }
  return { home, root, record: created, adapter, launch, activity, events, state }
}

test('Claude Code: launch settings report the main turn, its reply and a failure', { skip: !enabled }, async t => {
  for (const failure of [false, true])
    await t.test(failure ? 'failure' : 'reply', async t => {
      const id = crypto.randomUUID()
      const fixture = await session(t, 'claude', id)
      if (!fixture) return t.skip('claude is not installed')
      const model = await provider(t)
      model.state.fail = failure
      const options = [...(await fixture.adapter.mcp(fixture.launch)), ...(await fixture.adapter.hooks(fixture.launch))]
      const child = spawn(fixture.launch.executable, ['--print', '--session-id', id, ...options, 'hook test'], {
        cwd: fixture.root,
        env: {
          ...fixture.launch.environment,
          ANTHROPIC_BASE_URL: model.url,
          ANTHROPIC_API_KEY: 'test-key',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          API_TIMEOUT_MS: '1000',
        },
        stdio: 'ignore',
      })
      t.after(() => child.kill('SIGKILL'))
      await fixture.state('working')
      assert.ok(fixture.events.includes('UserPromptSubmit'))
      await until(model.requested, 'the model request')
      model.release()
      // Some authentication failures exit without StopFailure; the transcript records the error.
      const done = await fixture.state(failure ? 'error' : 'finished')
      if (!failure) {
        fixture.activity.acknowledge(done.completionId!)
        assert.equal(fixture.activity.current.state, 'idle')
      }
    })
})

test('Kimi Code: its plugin reports the conversation; the wire reports turns', { skip: !enabled }, async t => {
  const fixture = await session(t, 'kimi', 'session_placeholder')
  if (!fixture) return t.skip('kimi is not installed')
  const model = await provider(t)
  const store = Object.values(fixture.record.storage)[0]
  // Kimi's HOME may differ from the one Outpost keeps its state under.
  const alternate = join(fixture.home, 'alternate home')
  mkdirSync(alternate)
  const env = { ...fixture.launch.environment, HOME: alternate }
  await fixture.adapter.mcp(fixture.launch)
  await fixture.adapter.mcp(fixture.launch)
  assert.equal(JSON.parse(readFileSync(join(store, 'plugins', 'installed.json'), 'utf8')).plugins.length, 1)
  writeFileSync(
    join(store, 'config.toml'),
    `defaultModel="fake"\n[models.fake]\nname="fake"\nprotocol="openai"\nbaseUrl="${model.url}"\napiKey="test-token"\nmaxContextSize=8192\n`,
  )
  const rpc = new JsonRpcProcess([fixture.launch.executable, 'acp'], env, fixture.root, 60_000)
  t.after(() => rpc.close())
  await rpc.call('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'outpost_native_test', version: '1.0' },
  })
  const native = (await rpc.call('session/new', { cwd: fixture.root, mcpServers: [] })).sessionId as string
  await until(() => fixture.activity.currentConversation === native, 'the SessionStart hook')
  model.release()
  const response = await rpc.call('session/prompt', {
    sessionId: native,
    prompt: [{ type: 'text', text: 'hook test' }],
  })
  assert.equal(response.stopReason, 'end_turn')
  const done = await fixture.state('finished')
  fixture.activity.acknowledge(done.completionId!)
  assert.equal(fixture.activity.current.state, 'idle')
  model.state.fail = true
  await rpc
    .call('session/prompt', { sessionId: native, prompt: [{ type: 'text', text: 'failure test' }] })
    .catch(() => {}) // ACP may report the turn's error in its response too.
  await fixture.state('error')
})

test(
  'Codex: only its launch hooks are trusted; they report the conversation and its turns',
  { skip: !enabled },
  async t => {
    const fixture = await session(t, 'codex', crypto.randomUUID())
    if (!fixture) return t.skip('codex is not installed')
    const model = await provider(t)
    const store = Object.values(fixture.record.storage)[0]
    const config = join(store, 'config.toml')
    // A user's own hook stays untrusted; Outpost never grants blanket trust.
    writeFileSync(config, 'hooks.Stop = [{hooks=[{type="command",command="echo user-hook"}]}]\n')
    const options = [
      ...(await fixture.adapter.mcp(fixture.launch)),
      ...(await fixture.adapter.hooks(fixture.launch)),
      '-c',
      'model_provider="activity_test"',
      '-c',
      `model_providers.activity_test=${toml({
        name: 'Test',
        base_url: model.url,
        wire_api: 'responses',
        requires_openai_auth: false,
        request_max_retries: 0,
        stream_max_retries: 0,
      })}`,
    ]
    const start = async () => {
      const rpc = new JsonRpcProcess(
        [fixture.launch.executable, 'app-server', ...options],
        fixture.launch.environment,
        fixture.root,
        60_000,
      )
      t.after(() => rpc.close())
      await rpc.call('initialize', {
        clientInfo: { name: 'outpost_native_test', version: '1.0' },
        capabilities: { experimentalApi: true },
      })
      rpc.send({ method: 'initialized', params: {} })
      const listed = await rpc.call('hooks/list', { cwds: [fixture.root] })
      const hooks = (listed.data as { hooks: Record<string, string>[] }[]).flatMap(entry => entry.hooks)
      return { rpc, hooks }
    }
    const { rpc, hooks } = await start()
    const own = hooks.filter(hook => hook.source === 'sessionFlags')
    assert.ok(own.length > 0 && own.every(hook => hook.trustStatus === 'trusted'), JSON.stringify(own))
    const user = hooks.find(hook => hook.command === 'echo user-hook')!
    assert.equal(user.trustStatus, 'untrusted')
    const thread = ((await rpc.call('thread/start', { cwd: fixture.root })).thread as { id: string }).id
    // Codex reports SessionStart with the first submitted turn.
    await rpc.call('turn/start', { threadId: thread, input: [{ type: 'text', text: 'hook test' }] })
    await until(() => fixture.activity.currentConversation === thread, 'the conversation from hooks')
    await until(model.requested, 'the model request')
    await fixture.state('working')
    model.release()
    const done = await fixture.state('finished')
    fixture.activity.acknowledge(done.completionId!)
    assert.equal(fixture.activity.current.state, 'idle')
    model.state.fail = true
    const other = ((await rpc.call('thread/start', { cwd: fixture.root })).thread as { id: string }).id
    await rpc.call('turn/start', { threadId: other, input: [{ type: 'text', text: 'failure test' }] })
    await fixture.state('error')
    assert.equal(fixture.activity.currentConversation, other)
    rpc.close()
    assert.ok(!readFileSync(config, 'utf8').includes('outpost'), "the user's configuration is not changed")
    // Trust the user granted themselves is kept.
    const saved = `${readFileSync(config, 'utf8')}\n[hooks.state]\n${toml(user.key)}=${toml({ enabled: true, trusted_hash: user.currentHash })}\n`
    writeFileSync(config, saved)
    const again = await start()
    assert.ok(
      again.hooks.every(hook => hook.trustStatus === 'trusted'),
      JSON.stringify(again.hooks),
    )
    assert.equal(readFileSync(config, 'utf8'), saved)
  },
)
