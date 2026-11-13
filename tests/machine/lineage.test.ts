// Message identity, forks and compactions, from transcripts in the tools' own
// record shapes through the machine's reader into the server's index.
import assert from 'node:assert/strict'
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { HistorySource } from '../../shared/history'
import { HistoryIndex } from '../../backend/history/index'
import { catalog, readBatch } from '../../machine/history'
import { machine, tools } from './fixtures'

const fixtures = fileURLToPath(new URL('../fixtures/history/', import.meta.url))
const embed = async () => new Float32Array(384)
const place = (from: string, to: string) => {
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(join(fixtures, from), to)
}

function setup(t: TestContext) {
  const home = machine(t)
  tools(t, home)
  place('claude-original.jsonl', join(home, '.claude/projects/-work-app/11111111-1111-4111-8111-111111111111.jsonl'))
  place('claude-continued.jsonl', join(home, '.claude/projects/-work-app/22222222-2222-4222-8222-222222222222.jsonl'))
  // The fork's path sorts before its origin's, so the index meets it first.
  place(
    'codex-fork.jsonl',
    join(home, '.codex/sessions/2026/11/03/rollout-a-44444444-4444-4444-8444-444444444444.jsonl'),
  )
  place(
    'codex-root.jsonl',
    join(home, '.codex/sessions/2026/11/03/rollout-b-33333333-3333-4333-8333-333333333333.jsonl'),
  )
  const sources = catalog([], null).sources
  const read = (source: HistorySource) => readBatch([], [{ source, checkpoint: null }])
  const index = new HistoryIndex(':memory:', 'secret', embed)
  t.after(() => index.close())
  const box = { id: 'box', name: 'Box', host: 'box' }
  for (const source of sources) index.ingest(box, read(source))
  const messages = (nativeId: string) => read(sources.find(source => source.nativeId === nativeId)!).files[0].messages
  return { home, sources, index, messages, ids: [box.id] }
}

test("adapters give messages the tool's own identity, mark compaction summaries and report recorded forks", async t => {
  const { sources, messages } = setup(t)
  const original = messages('11111111-1111-4111-8111-111111111111')
  assert.deepEqual(
    original.map(message => [message.identity.slice(0, 7), message.kind]),
    [
      ['claude:', 'message'],
      ['claude:', 'message'],
      ['claude:', 'summary'],
      ['claude:', 'message'],
      ['claude:', 'message'],
    ],
  )
  assert.equal(original[0].identity, 'claude:a0000001-0000-4000-8000-000000000001')
  // The continuation's copies keep their identities; an unknown record kind is skipped.
  const continued = messages('22222222-2222-4222-8222-222222222222')
  assert.deepEqual(
    continued.map(message => message.identity),
    [original[3].identity, original[4].identity, 'claude:a0000001-0000-4000-8000-000000000007'],
  )
  const root = messages('33333333-3333-4333-8333-333333333333')
  assert.deepEqual(
    root.map(message => [message.identity.startsWith('codex:msg_'), message.kind]),
    [
      [true, 'message'],
      [true, 'message'],
      [false, 'summary'],
      [true, 'message'],
    ],
  )
  assert.match(root[2].text, /token bucket per client/)
  const fork = sources.find(source => source.nativeId === '44444444-4444-4444-8444-444444444444')!
  assert.equal(fork.forkedFrom, '33333333-3333-4333-8333-333333333333')
  const title = sources.find(source => source.nativeId === '11111111-1111-4111-8111-111111111111')!.title
  assert.equal(title, 'Schema migration plan', "Claude Code's own title")
})

test('copies are reported once, where they began, with their forks and compaction noted', async t => {
  const { index, ids } = setup(t)
  const swap = await index.search({ query: 'swap the tables', mode: 'keyword', groupBy: 'message' }, ids)
  assert.equal(swap.results.length, 1)
  assert.equal(swap.results[0].nativeSessionId, '11111111-1111-4111-8111-111111111111')
  assert.deepEqual(
    swap.results[0].alsoIn?.map(item => item.nativeSessionId),
    ['22222222-2222-4222-8222-222222222222'],
  )
  const staging = await index.search({ query: 'staging table', mode: 'keyword', groupBy: 'message' }, ids)
  assert.equal(staging.results.length, 1, 'the compaction summary repeats it and is not searched')
  assert.match(staging.results[0].beforeCompaction ?? '', /summary/)
  // The recorded Codex fork links even though the index read it first.
  const bucket = await index.search({ query: 'token bucket per client', mode: 'keyword', groupBy: 'message' }, ids)
  assert.equal(bucket.results.length, 1)
  assert.equal(bucket.results[0].nativeSessionId, '33333333-3333-4333-8333-333333333333')
  const sliding = await index.search({ query: 'sliding window', mode: 'keyword' }, ids)
  const lineage = index.session(String(sliding.results[0].sessionId), ids).lineage
  assert.equal(lineage.forkedFrom?.nativeSessionId, '33333333-3333-4333-8333-333333333333')
  const at = index.context({ cursor: lineage.forkedFrom!.cursor! }, ids)
  assert.ok(
    at.messages.some(message =>
      message.branches?.some(branch => branch.nativeSessionId === '44444444-4444-4444-8444-444444444444'),
    ),
  )
})

test('identities without a native ID stay the same however the file is read', async t => {
  const home = machine(t)
  tools(t, home)
  const wire = join(home, '.kimi-code/sessions/project/session_lineage/agents/main/wire.jsonl')
  mkdirSync(dirname(wire), { recursive: true })
  writeFileSync(join(home, '.kimi-code/sessions/project/session_lineage/state.json'), '{}')
  const line = (role: string, text: string) =>
    JSON.stringify({ type: 'context.append_message', message: { role, content: text } }) + '\n'
  writeFileSync(wire, line('user', 'ok') + line('assistant', 'ok'))
  const source = catalog([], null).sources[0]
  const first = readBatch([], [{ source, checkpoint: null }]).files[0]
  appendFileSync(wire, line('user', 'ok'))
  const next = readBatch([], [{ source, checkpoint: first.checkpoint }]).files[0]
  const whole = readBatch([], [{ source, checkpoint: null }]).files[0]
  const identities = [...first.messages, ...next.messages].map(message => message.identity)
  assert.deepEqual(
    identities,
    whole.messages.map(message => message.identity),
  )
  assert.equal(new Set(identities).size, 3, 'repeated text in one conversation is three messages')
})
