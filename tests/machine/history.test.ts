// Native history reads: formats, incremental checkpoints, confinement, paging, and the MCP tool surface.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { HistorySource } from '../../shared/history'
import { harness } from '../../machine/harnesses'
import { catalog, readBatch, readMessage } from '../../machine/history'
import { Scan } from '../../machine/stores'
import { machine, record, tools } from './fixtures'

const binary = fileURLToPath(
  new URL(`../../machine/dist/outpost-terminal-linux-${process.arch}-glibc`, import.meta.url),
)
const put = (path: string, records: object[]) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, records.map(record => JSON.stringify(record) + '\n').join(''))
}

function setup(t: TestContext) {
  const home = machine(t)
  tools(t, home)
  const codex = crypto.randomUUID()
  const claude = crypto.randomUUID()
  const codexPath = join(home, '.codex/sessions/2026/11/11', `rollout-${codex}.jsonl`)
  const populate = () => {
    put(codexPath, [
      {
        type: 'session_meta',
        payload: { id: codex, cwd: '/work/project', base_instructions: 'PRIVATE_CONFIGURATION_NOT_CHAT' },
      },
      {
        type: 'response_item',
        timestamp: '2026-11-01T12:00:00Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix 缓存失效' }] },
      },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Fix 缓存失效' } },
      { type: 'response_item', payload: { type: 'function_call_output', output: 'cache tool output' } },
    ])
    put(join(home, '.claude/projects/project', `${claude}.jsonl`), [
      { type: 'user', cwd: '/work/project', message: { content: 'Find the configuration bug' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Claude diagnosis' }] } },
    ])
    put(join(home, '.claude/projects/project', claude, 'subagents/agent-one.jsonl'), [
      { type: 'assistant', message: { content: 'Subagent diagnosis' } },
    ])
    const kimi = join(home, '.kimi-code/sessions/project/session_example')
    mkdirSync(join(kimi, 'agents/main'), { recursive: true })
    writeFileSync(join(kimi, 'state.json'), JSON.stringify({ title: 'Kimi debugging' }))
    put(join(home, '.kimi-code/session_index.jsonl'), [{ sessionId: 'session_example', workDir: '/work/kimi' }])
    put(join(kimi, 'agents/main/wire.jsonl'), [
      {
        type: 'context.append_message',
        time: '2026-11-02T12:00:00Z',
        message: { role: 'user', content: 'Kimi request' },
      },
      {
        type: 'context.append_message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Kimi answer' }] },
      },
    ])
  }
  const codexSource = () => catalog([], null).sources.find(source => source.tool === 'codex')!
  return { home, codexPath, populate, codexSource }
}

test('every native store and subagent is read once, without configuration', async t => {
  const { populate } = setup(t)
  populate()
  const sources: HistorySource[] = []
  let after: string | null = null
  do {
    const page = catalog([], after, 2)
    sources.push(...page.sources)
    after = page.next
  } while (after)
  assert.equal(sources.length, 4)
  assert.deepEqual(new Set(sources.map(source => source.tool)), new Set(['claude', 'codex', 'kimi']))
  const batch = readBatch(
    [],
    sources.map(source => ({ source, checkpoint: null })),
  )
  const messages = batch.files.flatMap(file => file.messages)
  assert.equal(messages.length, 7)
  assert.equal(messages.filter(message => message.text === 'Fix 缓存失效').length, 1, 'a prompt echo is not a message')
  assert.ok(!JSON.stringify(messages).includes('PRIVATE_CONFIGURATION_NOT_CHAT'))
  assert.ok(messages.some(message => message.role === 'tool'))
})

test('checkpoints continue appends, wait for a torn UTF-8 line and reset on replacement', async t => {
  const { populate, codexSource, codexPath } = setup(t)
  populate()
  const source = codexSource()
  const read = (checkpoint: unknown) => readBatch([], [{ source, checkpoint }]).files[0]
  const first = read(null)
  const unchanged = read(first.checkpoint)
  assert.deepEqual(unchanged.messages, [])
  assert.equal(unchanged.reset, false)
  const appended = Buffer.from(
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: '解决缓存失效' },
    }) + '\n',
  )
  const split = appended.indexOf(Buffer.from('解')) + 1
  appendFileSync(codexPath, appended.subarray(0, split))
  const partial = read(first.checkpoint)
  assert.equal(partial.checkpoint.offset, first.checkpoint.offset)
  assert.deepEqual(partial.messages, [])
  appendFileSync(codexPath, appended.subarray(split))
  const complete = read(partial.checkpoint)
  assert.equal(complete.reset, false)
  assert.equal(complete.checkpoint.generation, first.checkpoint.generation)
  assert.equal(complete.messages[0].text, '解决缓存失效')
  put(codexPath, [
    { type: 'session_meta', payload: { id: source.nativeId, cwd: '/work/project' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: 'Replacement' } },
  ])
  const replacement = read(complete.checkpoint)
  assert.equal(replacement.reset, true)
  assert.notEqual(replacement.checkpoint.generation, first.checkpoint.generation)
  assert.equal(replacement.messages[0].text, 'Replacement')
})

test('sources are confined to their stores; escaping symlinks are not read', async t => {
  const { populate, codexSource, codexPath, home } = setup(t)
  populate()
  const source = codexSource()
  const secret = join(home, 'secret.jsonl')
  writeFileSync(secret, 'PRIVATE_OUTSIDE_HISTORY\n')
  const forged = readBatch([], [{ source: { ...source, path: secret }, checkpoint: null }])
  assert.deepEqual(forged.files, [])
  assert.ok(forged.warnings.length)
  unlinkSync(codexPath)
  symlinkSync(secret, codexPath)
  const escaped = readBatch([], [{ source, checkpoint: null }])
  assert.deepEqual(escaped.files, [])
  assert.ok(!JSON.stringify(escaped).includes('PRIVATE_OUTSIDE_HISTORY'))
})

test('a long message is indexed by its prefix and read in pages', async t => {
  const { codexPath } = setup(t)
  const maxText = 1024 * 1024
  const text = 'x'.repeat(maxText - 5) + '😀中文'.repeat(8000)
  put(codexPath, [
    { type: 'session_meta', payload: { id: crypto.randomUUID(), cwd: '/work' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: text } },
  ])
  const source = catalog([], null).sources[0]
  const message = readBatch([], [{ source, checkpoint: null }]).files[0].messages[0]
  assert.equal(message.truncated, true)
  assert.equal(message.totalChars, text.length)
  const request = { source, position: message.position, contentHash: message.contentHash, offset: maxText, limit: 5000 }
  const page = readMessage([], request)
  assert.equal(page.text, text.slice(maxText, maxText + 5000))
  assert.equal(page.nextOffset, maxText + 5000)
  assert.equal(page.totalChars, text.length)
  assert.throws(() => readMessage([], { ...request, contentHash: 'invalid' }), /changed/)
})

test('Kimi: the current wire format reads canonical messages without duplicate context events', async t => {
  const { home } = setup(t)
  const root = join(home, '.kimi-code/sessions/project/session_current')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'state.json'), '{}')
  put(join(root, 'agents/main/wire.jsonl'), [
    { type: 'metadata', protocol_version: '1.5' },
    {
      type: 'agent.message.appended',
      time: '2026-11-11T12:00:00Z',
      message: {
        message: { role: 'user', content: [{ type: 'text', text: 'Find the deployment bug' }] },
        meta: { source: 'prompt' },
      },
    },
    { type: 'context.append_message', message: { role: 'user', content: 'Find the deployment bug' } },
    {
      type: 'context.append_loop_event',
      event: { type: 'content.part', part: { type: 'text', text: 'The certificate expired' } },
    },
    {
      type: 'agent.message.appended',
      message: {
        message: { role: 'assistant', content: [{ type: 'text', text: 'The certificate expired' }] },
        meta: {},
      },
    },
  ])
  const source = catalog([], null).sources[0]
  const messages = readBatch([], [{ source, checkpoint: null }]).files[0].messages
  assert.deepEqual(
    messages.map(message => [message.role, message.text]),
    [
      ['user', 'Find the deployment bug'],
      ['assistant', 'The certificate expired'],
    ],
  )
})

test("Outpost's MCP server offers each driver its tools, and fails closed on a partial binding", async t => {
  const home = machine(t)
  const session = crypto.randomUUID()
  const state = join(home, '.outpost')
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OUTPOST_')))
  const run = (env: Record<string, string>) =>
    spawnSync(binary, ['mcp'], {
      input: requests.map(request => JSON.stringify(request) + '\n').join(''),
      encoding: 'utf8',
      env: { ...clean, HOME: home, ...env },
    })
  const every = [
    'publish_file',
    'search_history',
    'read_context',
    'read_message',
    'get_session',
    'refresh_index',
    'list_machines',
    'list_sessions',
    'message_session',
    'post_to_channel',
    'fetch_file',
  ]
  for (const [driver, expected] of [
    ['terminal', every],
    ['chat', every],
    [null, []],
  ] as const) {
    const result = run(
      driver ? { OUTPOST_SESSION_ID: session, OUTPOST_STATE_DIRECTORY: state, OUTPOST_DRIVER: driver } : {},
    )
    assert.equal(result.status, 0, result.stderr)
    const replies = result.stdout
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    assert.deepEqual(
      new Set(replies[1].result.tools.map((tool: { name: string }) => tool.name)),
      new Set(expected),
      String(driver),
    )
    if (driver) assert.match(replies[0].result.instructions, /untrusted/)
  }
  const partial = run({ OUTPOST_SESSION_ID: session, OUTPOST_STATE_DIRECTORY: state })
  assert.equal(partial.status, 1)
})

test("a title taken from a prompt leaves out the header of Outpost's composed prompts", async t => {
  const home = machine(t)
  const id = crypto.randomUUID()
  put(join(home, '.claude/projects/project', `${id}.jsonl`), [
    {
      type: 'user',
      cwd: '/work',
      message: { content: '[Outpost: message from @coder in #release]\nPlease review the notes' },
    },
  ])
  const session = record(home, 'claude', id, { storage: { CLAUDE_CONFIG_DIR: join(home, '.claude') } })
  assert.equal(harness('claude').title(session, id, new Scan()), 'Please review the notes')
})
