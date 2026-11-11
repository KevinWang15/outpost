import assert from 'node:assert/strict'
import test from 'node:test'
import type { HistoryBatch, HistoryMachine, HistorySource } from '../../shared/history'
import { HistoryIndex } from '../../backend/history/index'
import type { Embed } from '../../backend/history/embeddings'

const machines: HistoryMachine[] = [
  { id: 'alpha', name: 'Build server', host: 'alpha.example' },
  { id: 'beta', name: 'Laptop', host: 'beta.example' },
]
const ids = machines.map(m => m.id)
const embed: Embed = async text => {
  const v = new Float32Array(384)
  // Independent vocabulary: semantic matches need no shared search terms.
  const animal = /kitten|feline|猫咪|小猫/i.test(text),
    release = /release|deployment|publishing|上线/i.test(text)
  v[animal ? 0 : release ? 1 : 2] = 1
  return v
}
function source(id: string, tool: HistorySource['tool'] = 'codex'): HistorySource {
  return {
    id,
    tool,
    nativeId: `native-${id}`,
    home: '/home/test/.tool',
    path: `/home/test/.tool/${id}.jsonl`,
    title: `Session ${id}`,
    cwd: '/projects/outpost',
    size: 1000,
    modified: '1000',
  }
}
function batch(s: HistorySource, texts: string[], generation = 'first', start = 0, reset = true): HistoryBatch {
  return {
    files: [
      {
        source: s,
        checkpoint: {
          offset: 1000,
          size: 1000,
          modified: '1000',
          generation,
          prefix: 'prefix',
          prefixSize: 10,
          tail: 'tail',
          tailSize: 10,
        },
        reset,
        pending: false,
        messages: texts.map((text, i) => ({
          position: start + i * 100,
          role: i % 2 ? 'assistant' : 'user',
          kind: 'message',
          text,
          timestamp: `2026-11-${String(1 + i).padStart(2, '0')}T12:00:00.000Z`,
          turnId: null,
          truncated: false,
        })),
      },
    ],
    warnings: [],
  }
}
function setup(t: test.TestContext) {
  const index = new HistoryIndex(':memory:', 'account-secret', embed)
  t.after(() => index.close())
  return index
}

test('history: keyword/substring search spans machines and tools, preserves attribution, and treats input literally', async t => {
  const index = setup(t)
  index.ingest(
    machines[0],
    batch(source('one', 'claude'), ['Investigate src/cache.ts and 缓存失效', 'Publish the release']),
  )
  index.ingest(
    machines[1],
    batch(source('two', 'kimi'), ['Investigate src/cache.ts and 缓存失效', 'Another discussion']),
  )
  for (const query of ['src/cache.ts', '缓存失效', '缓存']) {
    const result = await index.search({ query, mode: 'keyword' }, ids)
    assert.equal(result.results.length, 2)
    assert.deepEqual(new Set(result.results.map(r => r.machine.id)), new Set(ids))
    assert.deepEqual(new Set(result.results.map(r => r.tool)), new Set(['claude', 'kimi']))
  }
  assert.equal((await index.search({ query: 'src/cache.ts and', mode: 'substring' }, ids)).results.length, 2)
  assert.equal((await index.search({ query: 'cache.ts missing', mode: 'keyword' }, ids)).results.length, 0)
  for (const query of ['" OR 1=1 --', '[.*]', '$(touch injected)'])
    assert.equal((await index.search({ query, mode: 'keyword' }, ids)).results.length, 0)
  const grouped = await index.search({ query: 'cache.ts', mode: 'keyword', groupBy: 'message' }, ids)
  assert.equal(grouped.results.length, 1)
  assert.deepEqual(new Set(grouped.results[0].occurrences.map(o => o.machine.id)), new Set(ids))
})

test('history: real SQLite vector search finds meaning without keywords and mixed combines both rankings', async t => {
  const index = setup(t)
  index.ingest(machines[0], batch(source('cat'), ['A small kitten sleeps beside the laptop']))
  index.ingest(machines[1], batch(source('release'), ['Production deployment finished successfully']))
  assert.equal((await index.search({ query: 'feline', mode: 'keyword' }, ids)).results.length, 0)
  await assert.rejects(index.search({ query: 'feline', mode: 'semantic' }, ids), /still indexing/)
  assert.equal(await index.embedPending(ids, 100), 2)
  assert.deepEqual(index.coverage(ids), { searchableChunks: 2, embeddedChunks: 2, pendingChunks: 0 })
  const semantic = await index.search({ query: 'feline', mode: 'semantic' }, ids)
  assert.equal(semantic.semanticStatus, 'used')
  assert.match(semantic.results[0].text, /kitten/)
  assert.equal(semantic.results[0].machine.id, 'alpha')
  const mixed = await index.search({ query: 'publishing the release', mode: 'mixed' }, ids)
  assert.equal(mixed.mode, 'hybrid')
  assert.match(mixed.results[0].text, /deployment/)
  assert.equal(mixed.results[0].machine.id, 'beta')
})

test('history: machine/tool/role/date filters apply to lexical and vector retrieval, and removed machines cannot be read', async t => {
  const index = setup(t)
  index.ingest(machines[0], batch(source('a', 'claude'), ['Release planning', 'Production deployment']))
  index.ingest(machines[1], batch(source('b', 'codex'), ['Release planning', 'Production deployment']))
  await index.embedPending(ids, 100)
  for (const mode of ['keyword', 'semantic', 'mixed'] as const) {
    const result = await index.search(
      {
        query: 'deployment',
        mode,
        machine: 'beta',
        tool: 'codex',
        role: 'assistant',
        after: '2026-11-02',
        before: '2026-11-02',
      },
      ids,
    )
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].machine.id, 'beta')
    assert.equal(result.results[0].role, 'assistant')
    const cursor = result.results[0].cursor
    assert.throws(() => index.readMessage({ cursor }, ['alpha']), /no longer accessible/)
  }
  assert.equal((await index.search({ query: 'deployment', mode: 'semantic' }, ['alpha'])).results.length, 1)
})

test('history: context/message paging is bounded and chronological; appends keep cursors stable, replacement invalidates them', async t => {
  const index = setup(t),
    s = source('long')
  const texts = ['first paragraph', 'needle ' + 'x'.repeat(18000), 'third paragraph', 'fourth paragraph']
  index.ingest(machines[0], batch(s, texts))
  const found = (await index.search({ query: 'needle', mode: 'keyword' }, ids)).results[0]
  const context = index.context({ cursor: found.cursor, limit: 3, maxChars: 50 }, ids)
  assert.equal(context.messages.length, 3)
  assert.equal(context.messages[0].text, texts[0])
  assert.ok(context.messages[1].text.startsWith('needle '))
  assert.equal(context.messages[2].text, texts[2])
  assert.ok(context.messages.reduce((n, m) => n + m.text.length, 0) <= 50)
  assert.equal(context.messages[1].truncated, true)
  assert.ok(context.afterCursor)
  const after = index.context({ cursor: context.afterCursor!, direction: 'after' }, ids)
  assert.deepEqual(
    after.messages.map(m => m.text),
    texts.slice(3),
  )
  let offset = 0,
    all = ''
  for (;;) {
    const page = index.readMessage({ cursor: found.cursor, offset, limit: 7000 }, ids)
    all += page.text
    if (page.nextOffset === null) break
    offset = page.nextOffset
  }
  assert.equal(all, texts[1])
  assert.equal(index.ingest(machines[0], batch(s, ['appended paragraph'], 'first', 500, false)), 1)
  assert.equal(index.readMessage({ cursor: found.cursor }, ids).totalChars, texts[1].length)
  const session = index.session(String(found.sessionId), ids)
  assert.equal(session.machine.id, 'alpha')
  assert.equal(session.nativeSessionId, 'native-long')
  assert.equal(index.ingest(machines[0], batch(s, ['replacement'], 'second')), 1)
  assert.throws(() => index.readMessage({ cursor: found.cursor }, ids), /Stale history cursor/)
  assert.throws(() => index.readMessage({ cursor: found.cursor + 'x' }, ids), /Invalid history cursor/)
  assert.equal((await index.search({ query: 'needle', mode: 'keyword' }, ids)).results.length, 0)
})

test('history: signed cursors cannot cross account indexes even with matching message IDs', async t => {
  const first = setup(t),
    second = new HistoryIndex(':memory:', 'different-account-secret', embed)
  t.after(() => second.close())
  first.ingest(machines[0], batch(source('a'), ['private alpha history']))
  second.ingest(machines[0], batch(source('a'), ['private beta history']))
  const result = (await first.search({ query: 'private', mode: 'keyword' }, ids)).results[0]
  assert.throws(() => second.readMessage({ cursor: result.cursor }, ids), /Invalid history cursor/)
})

test('history: paging counts Unicode characters and repeated chunks share one embedding', async t => {
  const index = setup(t)
  const text = '😀中文'.repeat(7000)
  index.ingest(machines[0], batch(source('unicode'), [text]))
  const found = (await index.search({ query: '中文', mode: 'keyword' }, ids)).results[0]
  let offset = 0,
    result = ''
  for (;;) {
    const page = index.readMessage({ cursor: found.cursor, offset, limit: 701 }, ids)
    result += page.text
    assert.equal(page.totalChars, [...text].length)
    if (page.nextOffset === null) break
    assert.ok(page.nextOffset > offset)
    offset = page.nextOffset
  }
  assert.equal(result, text)
  const repeated = 'x'.repeat(6000)
  index.ingest(machines[0], batch(source('repeat'), [repeated]))
  const rows = index.db.prepare('SELECT count(*) n FROM chunks WHERE text=?').get('x'.repeat(1600))!
  assert.equal(rows.n, 1)
})

test('history: a partial ingestion never checkpoints past missing messages and survives replay', async t => {
  const index = setup(t),
    s = source('durable'),
    file = batch(s, ['first message', 'second message']).files[0]
  index.ingest(machines[0], { files: [{ ...file, messages: file.messages.slice(0, 1) }], warnings: [] }, false)
  assert.equal(index.checkpoint('alpha', s), null)
  index.ingest(
    machines[0],
    { files: [{ ...file, reset: false, messages: file.messages.slice(1) }], warnings: [] },
    true,
  )
  assert.equal(index.checkpoint('alpha', s)?.offset, 1000)
  assert.equal((await index.search({ query: 'message', mode: 'keyword', groupBy: 'message' }, ids)).results.length, 2)
  index.ingest(machines[0], { files: [{ ...file, reset: false }], warnings: [] })
  assert.equal(index.db.prepare('SELECT count(*) n FROM messages').get()!.n, 2)
})

test('history: initial semantic indexing reaches another machine before a long transcript tail', async t => {
  const index = setup(t)
  const long = Array.from(
    { length: 60 },
    (_, i) => `Distinct section ${i}: ` + 'long deployment details '.repeat(70),
  ).join('\n')
  index.ingest(machines[0], batch(source('long-first'), [long]))
  index.ingest(machines[1], batch(source('short-second'), ['A kitten sleeps on the laptop']))
  assert.equal(await index.embedPending(ids, 2), 2)
  const reached = index.db
    .prepare(
      `SELECT DISTINCT s.machine_id FROM sources s JOIN messages m ON m.source_id=s.id JOIN document_chunks dc ON dc.document_id=m.document_id JOIN embeddings e ON e.chunk_id=dc.chunk_id ORDER BY s.machine_id`,
    )
    .all()
  assert.deepEqual(
    reached.map(row => row.machine_id),
    ids,
  )
})
