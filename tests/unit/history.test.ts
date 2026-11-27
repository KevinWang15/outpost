import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import type { HistoryBatch, HistoryMachine, HistorySource } from '../../shared/history'
import { HistoryIndex } from '../../backend/history/index'
import { HistoryIndexClient } from '../../backend/history/index-client'
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
    forkedFrom: null,
    managedSessionId: null,
  }
}
/** Messages are unique to their conversation unless `identities` says otherwise. */
function batch(
  s: HistorySource,
  texts: string[],
  generation = 'first',
  start = 0,
  reset = true,
  identities: (string | null)[] = [],
  kinds: string[] = [],
): HistoryBatch {
  return {
    files: [
      {
        source: s,
        checkpoint: {
          offset: 1000,
          size: 1000,
          sourceSize: 1000,
          modified: '1000',
          generation,
          prefix: 'prefix',
          prefixSize: 10,
          tail: 'tail',
          tailSize: 10,
          identity:
            identities.at(-1) ?? (texts.length ? `${s.id}:${generation}:${start + (texts.length - 1) * 100}` : null),
        },
        reset,
        pending: false,
        messages: texts.map((text, i) => ({
          position: start + i * 100,
          identity: identities[i] ?? `${s.id}:${generation}:${start + i * 100}`,
          role: i % 2 ? 'assistant' : 'user',
          kind: kinds[i] ?? 'message',
          text,
          timestamp: `2026-11-${String(1 + i).padStart(2, '0')}T12:00:00.000Z`,
          turnId: null,
          truncated: false,
          totalChars: [...text].length,
          contentHash: createHash('sha256').update(text).digest('hex'),
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

test('history rejects incomplete checkpoints and truncated messages before committing the batch', t => {
  const index = setup(t),
    native = source('stale')
  const initial = batch(native, ['indexed'])
  index.ingest(machines[0], initial)
  const stale = batch(native, ['replacement'])
  Reflect.deleteProperty(stale.files[0].messages[0], 'contentHash')
  assert.throws(() => index.ingest(machines[0], stale), /invalid history message/)
  Reflect.deleteProperty(stale.files[0].checkpoint, 'sourceSize')
  assert.throws(() => index.ingest(machines[0], stale), /invalid history checkpoint/)
  assert.deepEqual(index.checkpoints(machines[0].id, [native])[0].checkpoint, initial.files[0].checkpoint)
})

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
  assert.equal(mixed.mode, 'mixed')
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
  assert.equal((await index.search({ query: 'deployment', mode: 'semantic', tool: 'kimi' }, ids)).results.length, 0)
  assert.equal((await index.search({ query: 'deployment', mode: 'mixed' }, [])).results.length, 0)
})

test('history: one-time Kimi wire migration clears only Kimi checkpoints without rebuilding the index', t => {
  const directory = mkdtempSync(join(tmpdir(), 'outpost-kimi-migrate-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'index.sqlite')
  const kimi = source('k1', 'kimi')
  const codex = source('c1', 'codex')
  const first = new HistoryIndex(path, 'secret', embed)
  try {
    first.ingest(machines[0], batch(kimi, []))
    first.ingest(machines[0], batch(codex, ['keep codex']))
    // Simulate a pre-migration database that did not yet run the Kimi checkpoint reset.
    first.db.prepare("DELETE FROM settings WHERE key='kimi_wire_context'").run()
  } finally {
    first.close()
  }
  const reopened = new HistoryIndex(path, 'secret', embed)
  try {
    assert.equal(reopened.checkpoints('alpha', [kimi])[0].checkpoint, null)
    assert.equal(reopened.checkpoints('alpha', [codex])[0].checkpoint?.offset, 1000)
    reopened.ingest(machines[0], batch(kimi, ['now indexed']))
  } finally {
    reopened.close()
  }
  const third = new HistoryIndex(path, 'secret', embed)
  try {
    assert.equal(third.checkpoints('alpha', [kimi])[0].checkpoint?.offset, 1000)
  } finally {
    third.close()
  }
})

test('history: multi-term keyword search intersects across chunks and respects short terms and time sorting', async t => {
  const index = setup(t)
  const crossChunk = `alphaTerm v2 ${'padding '.repeat(350)} omegaTerm`
  index.ingest(
    machines[0],
    batch(source('multi', 'claude'), [
      'alphaTerm only in earlier message',
      crossChunk,
      'omegaTerm only in later message',
    ]),
  )
  index.ingest(machines[1], batch(source('both', 'codex'), ['alphaTerm and omegaTerm together in v2']))
  const multi = await index.search({ query: 'alphaTerm omegaTerm', mode: 'keyword', sort: 'oldest' }, ids)
  assert.deepEqual(
    multi.results.map(r => r.nativeSessionId),
    ['native-both', 'native-multi'],
  )
  const newest = await index.search({ query: 'alphaTerm omegaTerm', mode: 'keyword', sort: 'newest' }, ids)
  assert.deepEqual(
    newest.results.map(r => r.nativeSessionId),
    ['native-multi', 'native-both'],
  )
  assert.equal((await index.search({ query: 'alphaTerm omegaTerm v2', mode: 'keyword' }, ids)).results.length, 2)
  assert.equal((await index.search({ query: 'alphaTerm omegaTerm v3', mode: 'keyword' }, ids)).results.length, 0)
  assert.equal((await index.search({ query: 'alphaTerm v2', mode: 'keyword' }, ids)).results.length, 2)
  assert.equal((await index.search({ query: 'alphaTerm v3', mode: 'keyword' }, ids)).results.length, 0)
})

test('history: filtered semantic search tolerates partial embeddings and sorts by time', async t => {
  const index = setup(t)
  index.ingest(machines[0], batch(source('early', 'claude'), ['A kitten on day one', 'Another kitten on day two']))
  index.ingest(machines[1], batch(source('later', 'codex'), ['Unrelated topic', 'A third kitten on day two']))
  // Embed only two of the four chunks so some filter-matched chunks are still unembedded.
  assert.equal(await index.embedPending(ids, 2), 2)
  const newest = await index.search({ query: 'feline', mode: 'semantic', tool: 'claude', sort: 'newest' }, ids)
  assert.equal(newest.results.length, 1)
  assert.match(newest.results[0].text, /kitten/)
  assert.equal(await index.embedPending(ids, 10), 2)
  const ordered = await index.search(
    { query: 'feline', mode: 'semantic', tool: 'claude', groupBy: 'message', sort: 'newest' },
    ids,
  )
  assert.deepEqual(
    ordered.results.map(r => r.text),
    ['Another kitten on day two', 'A kitten on day one'],
  )
  const oldest = await index.search(
    { query: 'feline', mode: 'semantic', tool: 'claude', groupBy: 'message', sort: 'oldest' },
    ids,
  )
  assert.deepEqual(
    oldest.results.map(r => r.text),
    ['A kitten on day one', 'Another kitten on day two'],
  )
})

test('history: only a page inside the uncached tail needs a native read', async t => {
  const index = setup(t)
  const native = source('partial')
  const input = batch(native, ['find 😀'])
  const contentHash = createHash('sha256').update('find 😀tail').digest('hex')
  Object.assign(input.files[0].messages[0], { truncated: true, totalChars: 10, contentHash })
  index.ingest(machines[0], input)
  const { cursor } = (await index.search({ query: 'find', mode: 'keyword' }, ids)).results[0]
  const cached = index.readMessage({ cursor, offset: 5 }, ids)
  assert.equal(cached.page.text, '😀')
  assert.equal(cached.page.nextOffset, 6)
  assert.equal(cached.source, undefined)
  const tail = index.readMessage({ cursor, offset: 6, limit: 3 }, ids)
  assert.equal(tail.machineId, 'alpha')
  assert.deepEqual(tail.source, { source: native, position: 0, contentHash, offset: 6, limit: 3 })
  const end = index.readMessage({ cursor, offset: 10 }, ids)
  assert.equal(end.source, undefined)
  assert.equal(end.page.nextOffset, null)
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
    const { page } = index.readMessage({ cursor: found.cursor, offset, limit: 7000 }, ids)
    all += page.text
    if (page.nextOffset === null) break
    offset = page.nextOffset
  }
  assert.equal(all, texts[1])
  assert.equal(index.ingest(machines[0], batch(s, ['appended paragraph'], 'first', 500, false)), 1)
  assert.equal(index.readMessage({ cursor: found.cursor }, ids).page.totalChars, texts[1].length)
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
    const { page } = index.readMessage({ cursor: found.cursor, offset, limit: 701 }, ids)
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
  assert.equal(index.checkpoints('alpha', [s])[0].checkpoint, null)
  index.ingest(
    machines[0],
    { files: [{ ...file, reset: false, messages: file.messages.slice(1) }], warnings: [] },
    true,
  )
  assert.equal(index.checkpoints('alpha', [s])[0].checkpoint?.offset, 1000)
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

test('history: a fork or continuation shares messages with its origin; each is reported once, where it began', async t => {
  const index = setup(t)
  const original = { ...source('original', 'claude'), managedSessionId: 'outpost-a' }
  // The continuation copied the original's last two messages, then went on.
  index.ingest(
    machines[0],
    batch(original, ['Plan the migration', 'Use a staging table', 'Swap tables at night', 'Done'], 'g', 0, true, [
      'u1',
      'u2',
      'u3',
      'u4',
    ]),
  )
  index.ingest(
    machines[0],
    batch(source('continued', 'claude'), ['Swap tables at night', 'Done', 'Now verify the indexes'], 'g', 0, true, [
      'u3',
      'u4',
      'u5',
    ]),
  )
  const result = await index.search({ query: 'swap tables', mode: 'keyword', groupBy: 'message' }, ids)
  assert.equal(result.results.length, 1, 'one logical message')
  assert.equal(result.results[0].nativeSessionId, 'native-original')
  assert.equal(result.results[0].outpostSessionId, 'outpost-a')
  assert.deepEqual(
    result.results[0].alsoIn?.map(item => item.nativeSessionId),
    ['native-continued'],
  )
  // The continuation's own message is attributed to it.
  const own = await index.search({ query: 'verify the indexes', mode: 'keyword' }, ids)
  assert.equal(own.results[0].nativeSessionId, 'native-continued')
  // Reading the original shows where the continuation went; reading that, where it came from.
  const around = index.context({ cursor: result.results[0].cursor, limit: 7 }, ids)
  const fork = around.messages.find(message => message.text.startsWith('Done'))!
  assert.deepEqual(
    fork.branches?.map(branch => branch.nativeSessionId),
    ['native-continued'],
  )
  const branch = index.context({ cursor: fork.branches![0].cursor! }, ids)
  assert.equal(branch.forkedFrom?.nativeSessionId, 'native-original')
  assert.match(index.context({ cursor: branch.forkedFrom!.cursor! }, ids).messages.at(-1)!.text, /Done/)
  const lineage = index.session(String(own.results[0].sessionId), ids).lineage
  assert.equal(lineage.forkedFrom?.nativeSessionId, 'native-original')
  assert.deepEqual(
    index.session(String(result.results[0].sessionId), ids).lineage.branches.map(item => item.nativeSessionId),
    ['native-continued'],
  )
})

test('history: a fork the tool records links even when ingested before its origin', async t => {
  const index = setup(t)
  const fork = { ...source('fork'), forkedFrom: 'native-root' }
  index.ingest(machines[0], batch(fork, ['Shared start', 'Fork only'], 'g', 0, true, ['c1', 'c3']))
  index.ingest(machines[0], batch(source('root'), ['Shared start', 'Root only'], 'g', 0, true, ['c1', 'c2']))
  assert.equal(
    index.session(String((await index.search({ query: 'fork only', mode: 'keyword' }, ids)).results[0].sessionId), ids)
      .lineage.forkedFrom?.nativeSessionId,
    'native-root',
  )
  const shared = await index.search({ query: 'shared start', mode: 'keyword', groupBy: 'message' }, ids)
  assert.equal(shared.results.length, 1)
  assert.equal(shared.results[0].nativeSessionId, 'native-root')
})

test('history: compactions mark what the agent now has only as a summary; summaries repeat nothing', async t => {
  const index = setup(t)
  index.ingest(
    machines[0],
    batch(
      source('long', 'claude'),
      ['Design the cache layer', 'Summary: the cache layer was designed', 'Continue with eviction'],
      'g',
      0,
      true,
      [],
      ['message', 'summary', 'message'],
    ),
  )
  const before = await index.search({ query: 'cache layer', mode: 'keyword', groupBy: 'message' }, ids)
  assert.equal(before.results.length, 1, 'the summary is not searched while its originals are indexed')
  assert.match(before.results[0].beforeCompaction ?? '', /only a summary/)
  const after = await index.search({ query: 'eviction', mode: 'keyword' }, ids)
  assert.equal(after.results[0].beforeCompaction, undefined)
  const context = index.context({ cursor: after.results[0].cursor, direction: 'before' }, ids)
  assert.ok(context.messages.some(message => message.kind === 'summary' && message.compaction))
  // A conversation that starts from a summary (its originals are gone) is searched through it.
  index.ingest(
    machines[0],
    batch(
      source('resumed', 'claude'),
      ['Summary: billing exports were rebuilt', 'Next step'],
      'g',
      0,
      true,
      [],
      ['summary', 'message'],
    ),
  )
  assert.equal((await index.search({ query: 'billing exports', mode: 'keyword' }, ids)).results.length, 1)
})

test('history: results group by Outpost session across its timeline, and sessionId accepts the Outpost session', async t => {
  const index = setup(t)
  index.ingest(machines[0], batch({ ...source('first'), managedSessionId: 'outpost-s' }, ['Rotate the keys']))
  index.ingest(machines[0], batch({ ...source('second'), managedSessionId: 'outpost-s' }, ['Rotate the keys again']))
  index.ingest(machines[0], batch(source('other'), ['Rotate the keys elsewhere']))
  const grouped = await index.search({ query: 'rotate the keys', mode: 'keyword' }, ids)
  assert.equal(grouped.results.length, 2)
  const outpost = grouped.results.find(item => item.outpostSessionId === 'outpost-s')!
  assert.equal(outpost.matchingMessages, 2)
  assert.equal(
    (await index.search({ query: 'rotate', mode: 'keyword', sessionId: 'outpost-s', groupBy: 'message' }, ids)).results
      .length,
    2,
  )
  const session = index.session(String(outpost.sessionId), ids)
  assert.deepEqual(session.outpostSession?.conversations.map(item => item.nativeSessionId).sort(), [
    'native-first',
    'native-second',
  ])
})

test('opening an unsupported history index preserves its contents', t => {
  const folder = mkdtempSync(join(tmpdir(), 'outpost-history-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const path = join(folder, 'history.db')
  const original = new DatabaseSync(path)
  original.exec(
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT); INSERT INTO settings VALUES ('schema','unknown'), ('marker','preserved')",
  )
  original.close()
  assert.throws(() => new HistoryIndex(path, 'account-secret', embed), /Unsupported history index schema/)
  const reopened = new DatabaseSync(path, { readOnly: true })
  try {
    assert.equal(reopened.prepare("SELECT value FROM settings WHERE key='marker'").get()?.value, 'preserved')
  } finally {
    reopened.close()
  }
})

test('history: the durable embedding queue counts shared chunks once and survives replay and source replacement', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'outpost-history-queue-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'index.sqlite')
  const first = new HistoryIndex(path, 'secret', embed)
  try {
    first.ingest(machines[0], batch(source('one'), ['shared', 'shared']))
    await first.embedPending(['alpha'])
    first.ingest(machines[1], batch(source('two'), ['shared', 'unique']))
  } finally {
    first.close()
  }
  const index = new HistoryIndex(path, 'secret', embed)
  try {
    assert.deepEqual(index.coverage(ids), { searchableChunks: 2, embeddedChunks: 1, pendingChunks: 1 })
    assert.equal(index.db.prepare("SELECT refs FROM machine_chunks WHERE machine_id='alpha'").get()!.refs, 2)
    assert.deepEqual(await Promise.all([index.embedPending(['alpha']), index.embedPending(['beta'])]), [0, 1])
    index.ingest(machines[1], batch(source('two'), ['shared'], 'replacement'))
    index.ingest(machines[1], batch(source('two'), ['shared'], 'replacement', 0, false))
    index.ingest(machines[1], batch(source('three'), ['shared']))
    index.ingest(machines[1], batch(source('two'), [], 'empty'))
    assert.deepEqual(index.coverage(['beta']), { searchableChunks: 1, embeddedChunks: 1, pendingChunks: 0 })
    index.db.prepare('DELETE FROM sources WHERE id=?').run(index.sourceKey('beta', 'three'))
    assert.equal(index.coverage(['beta']).searchableChunks, 0)
    assert.equal(index.coverage(['alpha']).embeddedChunks, 1)
    const changes = () => index.db.prepare('SELECT total_changes() n').get()!.n
    const before = changes()
    assert.deepEqual(index.catalog(machines[0], [source('one')]), [])
    assert.equal(changes(), before)
    const renamed = { ...source('one'), title: 'Renamed' }
    assert.deepEqual(index.catalog(machines[0], [renamed]), [])
    assert.equal(
      index.db.prepare('SELECT title FROM sources WHERE id=?').get(index.sourceKey('alpha', 'one'))!.title,
      renamed.title,
    )
    assert.deepEqual(index.catalog(machines[0], [{ ...renamed, size: 1050 }]), [{ ...renamed, size: 1050 }])
  } finally {
    index.close()
  }
})

test('history: a blocked SQLite write leaves the server event loop free and worker embeddings use the shared model', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'outpost-history-worker-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'index.sqlite')
  const calls: string[] = []
  const client = new HistoryIndexClient(path, 'secret', (text, kind) => {
    calls.push(kind)
    return embed(text, kind)
  })
  const lock = new DatabaseSync(path)
  try {
    await client.call('coverage', ids)
    lock.exec('BEGIN IMMEDIATE')
    const release = setTimeout(() => lock.exec('COMMIT'), 100)
    try {
      assert.equal(await client.call('ingest', machines[0], batch(source('one'), ['a kitten'])), 1)
    } finally {
      clearTimeout(release)
    }
    assert.equal(await client.call('embedPending', ids), 1)
    const result = await client.call('search', { query: 'feline', mode: 'semantic' }, ids)
    assert.equal(result.results.length, 1)
    assert.deepEqual(calls, ['passage', 'query'])
  } finally {
    lock.close()
    await client.close()
  }
  await assert.rejects(client.call('coverage', ids), /closed/)
})
