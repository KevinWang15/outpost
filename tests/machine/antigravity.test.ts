// Antigravity CLI stores: SQLite summaries, brain transcripts, subagent
// attribution, `<USER_REQUEST>` unwrapping, plugin setup and confinement.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'
import { harness } from '../../machine/harnesses'
import { catalog, readBatch } from '../../machine/history'
import { prepare } from '../../machine/launch'
import { searchConversations } from '../../machine/search'
import { statePath } from '../../machine/state'
import { Scan } from '../../machine/stores'
import { machine, record, register, tools } from './fixtures'

function putLines(path: string, rows: object[]) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, rows.map(row => JSON.stringify(row) + '\n').join(''))
}

function setup(t: TestContext) {
  const home = machine(t)
  tools(t, home)
  const store = join(home, '.gemini')
  const cli = join(store, 'antigravity-cli')
  mkdirSync(cli, { recursive: true })
  const databasePath = join(cli, 'conversation_summaries.db')
  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id text PRIMARY KEY,
      title text NOT NULL DEFAULT "",
      preview text NOT NULL DEFAULT "",
      step_count integer NOT NULL DEFAULT 0,
      last_modified_time datetime NOT NULL,
      workspace_uris text NOT NULL,
      parent_conversation_id text NOT NULL DEFAULT "",
      nesting_depth integer NOT NULL DEFAULT 0,
      last_user_input_time datetime NOT NULL
    )
  `)
  database.close()
  const addSummary = (row: {
    id: string
    cwd: string
    title?: string
    preview?: string
    updated?: string
    created?: string
    parent?: string
    depth?: number
  }) => {
    const conn = new DatabaseSync(databasePath)
    try {
      conn
        .prepare('INSERT OR REPLACE INTO conversation_summaries VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)')
        .run(
          row.id,
          row.title ?? '',
          row.preview ?? '',
          row.updated ?? '2026-11-16 02:38:07.218760483+00:00',
          JSON.stringify([pathToFileURL(row.cwd).href]),
          row.parent ?? '',
          row.depth ?? 0,
          row.created ?? '0001-01-01 00:00:00+00:00',
        )
    } finally {
      conn.close()
    }
  }
  const transcriptPath = (id: string, full = true) =>
    join(cli, 'brain', id, '.system_generated', 'logs', full ? 'transcript_full.jsonl' : 'transcript.jsonl')
  return { home, store, cli, addSummary, transcriptPath }
}

test('summaries, full transcripts, composed prompts and subagents are indexed once and searchable', async t => {
  const { home, store, addSummary, transcriptPath } = setup(t)
  const rootId = crypto.randomUUID()
  const childId = crypto.randomUUID()
  const work = join(home, "project ' 缓存")
  mkdirSync(work, { recursive: true })
  addSummary({ id: rootId, cwd: work, title: '' })
  addSummary({ id: childId, cwd: work, parent: rootId, depth: 1 })

  // Compact transcript is truncated; transcript_full.jsonl has the full message and wins.
  putLines(transcriptPath(rootId, false), [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'TRUNCATED_COMPACT_ONLY' },
  ])
  putLines(transcriptPath(rootId, true), [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-16T02:01:03Z',
      content:
        '<USER_REQUEST>\n[Outpost: #ops]\nFix 缓存失效\n\nYou are @agy in #ops.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nLOCAL_TIME_METADATA_NOISE\n</ADDITIONAL_METADATA>',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-16T02:01:04Z',
      thinking: 'ANTIGRAVITY_THINKING_TRACE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-16T02:01:05Z',
      content: 'Tool output: cache check passed',
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-16T02:01:06Z',
      content: 'Resolved the cache invalidation bug.',
    },
  ])
  putLines(transcriptPath(childId, true), [
    {
      step_index: 0,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: '2026-11-16T02:01:04Z',
      content: 'SYSTEM_INTERNAL_PROMPT',
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-16T02:01:05Z',
      content: 'SUBAGENT_DEEP_FINDING',
    },
  ])

  const discovered = [...harness('antigravity').discover(process.env as Record<string, string>, new Scan())]
  assert.equal(discovered.length, 1, 'subagents are not offered as standalone sessions to resume')
  assert.equal(discovered[0].id, rootId)
  assert.equal(discovered[0].root, work)
  assert.equal(discovered[0].title, '#ops · Fix 缓存失效')
  assert.equal(discovered[0].created, '2026-11-16T02:01:03.000Z')
  assert.equal(discovered[0].updated, '2026-11-16T02:38:07.218Z')

  // Keyword search finds root text, thinking, tool output and subagent replies under the root conversation.
  for (const needle of ['缓存失效', 'ANTIGRAVITY_THINKING_TRACE', 'cache check passed', 'SUBAGENT_DEEP_FINDING']) {
    const found = searchConversations(needle, 'antigravity', [])
    assert.deepEqual(
      found.sessions.map(item => item.conversation),
      [rootId],
      needle,
    )
  }
  assert.equal(searchConversations('LOCAL_TIME_METADATA_NOISE', 'antigravity', []).sessions.length, 0)
  assert.equal(searchConversations('TRUNCATED_COMPACT_ONLY', 'antigravity', []).sessions.length, 0)

  // Cross-machine history catalog attributes both transcripts to the root conversation and its Outpost session.
  const session = record(home, 'antigravity', rootId, { storage: { ANTIGRAVITY_GEMINI_DIR: store } })
  const sources = catalog([session], null).sources.filter(source => source.tool === 'antigravity')
  assert.equal(sources.length, 2)
  assert.ok(sources.every(source => source.nativeId === rootId && source.managedSessionId === session.id))
  const batch = readBatch(
    [session],
    sources.map(source => ({ source, checkpoint: null })),
  )
  const rootFile = batch.files.find(file => file.source.path.includes(rootId))
  const childFile = batch.files.find(file => file.source.path.includes(childId))
  assert.deepEqual(
    rootFile?.messages.map(message => [message.role, message.kind]),
    [
      ['user', 'message'],
      ['tool', 'tool_result'],
      ['assistant', 'message'],
    ],
  )
  assert.deepEqual(
    childFile?.messages.map(message => [message.role, message.kind]),
    [['assistant', 'message']],
  )
  const messages = batch.files.flatMap(file => file.messages)
  for (const forbidden of ['LOCAL_TIME_METADATA_NOISE', 'TRUNCATED_COMPACT_ONLY', 'SYSTEM_INTERNAL_PROMPT'])
    assert.ok(!JSON.stringify(messages).includes(forbidden), forbidden)
})

test('escaped symlinks are refused in discovery and history reads', async t => {
  const { home, addSummary, transcriptPath } = setup(t)
  const id = crypto.randomUUID()
  addSummary({ id, cwd: home, title: 'Linked' })
  const path = transcriptPath(id, true)
  putLines(path, [{ step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'ok' }])
  const outside = join(home, 'secret.jsonl')
  writeFileSync(
    outside,
    '{"step_index":0,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"SECRET"}\n',
  )
  unlinkSync(path)
  symlinkSync(outside, path)
  assert.deepEqual(catalog([], null).sources, [])
  assert.equal(searchConversations('SECRET', 'antigravity', []).sessions.length, 0)
})

test('the Outpost plugin is additive, idempotent, and rejects malformed plugins.json', async t => {
  const { home, store } = setup(t)
  const created = record(home, 'antigravity', crypto.randomUUID(), { storage: { ANTIGRAVITY_GEMINI_DIR: store } })
  await register(created)
  const pluginsPath = join(store, 'config', 'plugins.json')
  mkdirSync(dirname(pluginsPath), { recursive: true })
  writeFileSync(
    pluginsPath,
    JSON.stringify({
      inherits: [{ path: '/shared/plugins.json' }],
      entries: [{ path: '~/my-plugins', exclude: ['draft'] }],
    }),
  )
  const { adapter, launch } = prepare(created, 'terminal')
  await adapter.mcp(launch)
  await adapter.mcp(launch)
  const saved = JSON.parse(readFileSync(pluginsPath, 'utf8'))
  assert.deepEqual(saved.inherits, [{ path: '/shared/plugins.json' }])
  assert.deepEqual(saved.entries, [
    { path: '~/my-plugins', exclude: ['draft'] },
    { path: statePath('integrations', 'antigravity') },
  ])
  const mcpConfig = readFileSync(statePath('integrations', 'antigravity', 'outpost', 'mcp_config.json'), 'utf8')
  assert.ok(!mcpConfig.includes(created.id), 'plugin holds no session ID')

  writeFileSync(pluginsPath, '{"entries": "bad"}')
  await assert.rejects(() => adapter.mcp(launch), /Invalid Antigravity plugin configuration/)
})
