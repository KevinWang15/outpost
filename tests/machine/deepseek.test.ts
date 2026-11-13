// DeepSeek Harness stores: generations, zstd frames, appends and rewrites, confinement.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { constants, zstdCompressSync } from 'node:zlib'
import { harness } from '../../machine/harnesses'
import { catalog, readBatch, readMessage } from '../../machine/history'
import { searchConversations } from '../../machine/search'
import { Scan } from '../../machine/stores'
import { machine, tools } from './fixtures'

function records(id = 'native-example', version = 4): Record<string, unknown>[] {
  return [
    { type: 'session', version, id, cwd: '/projects/deepseek', createdAt: 1794380400000 },
    {
      type: 'user/message',
      seq: 0,
      time: 1794380400000,
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [
          { type: 'text', text: 'DeepSeek fixes 缓存失效' },
          { type: 'image', data: 'IMAGE_SECRET' },
        ],
      },
    },
    {
      type: 'assistant/message',
      seq: 1,
      time: 1794380400001,
      data: {
        turn: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Invalidate the cache' }] },
        stream: ['DUPLICATE_RAW_DELTAS'],
      },
    },
    {
      type: 'tool/result',
      seq: 2,
      time: 1794380400002,
      data: { turn: 1, message: { role: 'tool', content: [{ type: 'text', text: 'Cache test passed' }] } },
    },
    { type: 'system/message', seq: 3, data: { message: { content: 'SYSTEM_SECRET' } } },
    { type: 'request/header', seq: 4, data: { credentials: 'CREDENTIAL_SECRET' } },
    { type: 'session/title', seq: 5, data: { title: 'Named DeepSeek session' } },
  ]
}
const encoded = (rows: object[]) => Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join(''))
const compress = (data: Buffer) => zstdCompressSync(data, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })

function setup(t: TestContext) {
  const home = machine(t)
  tools(t, home)
  const store = join(home, '.dsh')
  const put = (id = 'native-example', options: { version?: number; compressed?: boolean; rows?: object[] } = {}) => {
    const version = options.version ?? 4
    const name = `session${version ? `.v${version}` : ''}.jsonl${options.compressed ? '.zstd' : ''}`
    const path = join(store, 'sessions', '--projects-deepseek--', id, name)
    mkdirSync(join(path, '..'), { recursive: true })
    const data = encoded(options.rows ?? records(id, version))
    writeFileSync(path, options.compressed ? compress(data) : data)
    return path
  }
  return { home, store, put }
}

test('raw and compressed generations read once, as canonical messages, and are searchable', async t => {
  const { put } = setup(t)
  for (let version = 0; version < 5; version++) put(`native-${version}`, { version, compressed: version % 2 === 1 })
  put('native-4', { version: 3 }) // A retained older generation is not indexed again.
  const sources = catalog([], null).sources
  assert.equal(sources.length, 5)
  assert.ok(sources.every(source => source.tool === 'deepseek' && source.title === 'Named DeepSeek session'))
  const batch = readBatch(
    [],
    sources.map(source => ({ source, checkpoint: null })),
  )
  assert.deepEqual(batch.warnings, [])
  const messages = batch.files.flatMap(file => file.messages)
  assert.equal(messages.length, 15)
  assert.deepEqual(new Set(messages.map(message => message.role)), new Set(['user', 'assistant', 'tool']))
  for (const forbidden of ['SYSTEM_SECRET', 'CREDENTIAL_SECRET', 'IMAGE_SECRET', 'DUPLICATE_RAW_DELTAS'])
    assert.ok(!JSON.stringify(messages).includes(forbidden), forbidden)
  const found = searchConversations('缓存', 'deepseek', [])
  assert.equal(found.sessions.length, 5)
  assert.deepEqual(found.warnings, [])
})

test('compressed appends continue the checkpoint; a torn frame waits; a rewrite resets', async t => {
  const { put } = setup(t)
  const path = put(undefined, { compressed: true })
  const source = catalog([], null).sources[0]
  const original = readFileSync(path)
  const read = (checkpoint: unknown) => readBatch([], [{ source, checkpoint }]).files[0]
  const first = read(null)
  const unchanged = read(first.checkpoint)
  assert.deepEqual(unchanged.messages, [])
  assert.equal(unchanged.reset, false)
  const frame = compress(encoded([{ type: 'assistant/message', data: { message: { content: 'Additional result' } } }]))
  appendFileSync(path, frame.subarray(0, frame.length >> 1))
  const torn = read(first.checkpoint)
  assert.deepEqual(torn.messages, [])
  assert.equal(torn.reset, false)
  assert.equal(torn.checkpoint.generation, first.checkpoint.generation)
  appendFileSync(path, frame.subarray(frame.length >> 1))
  const appended = read(first.checkpoint)
  assert.equal(appended.reset, false)
  assert.equal(appended.checkpoint.generation, first.checkpoint.generation)
  assert.deepEqual(
    appended.messages.map(message => message.text),
    ['Additional result'],
  )
  writeFileSync(path, original)
  const rewritten = read(appended.checkpoint)
  assert.equal(rewritten.reset, true)
  assert.notEqual(rewritten.checkpoint.generation, appended.checkpoint.generation)
})

test('a long compressed message pages by characters and the native file is unchanged', async t => {
  const { put } = setup(t)
  const text = '缓存🚀'.repeat(350_000)
  const path = put(undefined, {
    compressed: true,
    rows: [...records(), { type: 'assistant/message', data: { message: { content: text } } }],
  })
  const digest = () => createHash('sha256').update(readFileSync(path)).digest('hex')
  const before = digest()
  const source = catalog([], null).sources[0]
  const entry = readBatch([], [{ source, checkpoint: null }]).files[0].messages.at(-1)!
  assert.equal(entry.truncated, true)
  const page = readMessage([], {
    source,
    position: entry.position,
    contentHash: entry.contentHash,
    offset: 1048576,
    limit: 100,
  })
  assert.equal(page.text, text.slice(1048576, 1048676))
  assert.equal(digest(), before)
})

test('subagent runs are history but not sessions to resume; linked files are refused', async t => {
  const { put, home } = setup(t)
  const rows = records('child')
  rows[0].origin = 'subagent'
  const child = put('child', { rows })
  assert.equal(catalog([], null).sources.length, 1)
  assert.deepEqual([...harness('deepseek').discover(process.env as Record<string, string>, new Scan())], [])
  const outside = join(home, 'private.jsonl')
  writeFileSync(outside, readFileSync(child))
  unlinkSync(child)
  symlinkSync(outside, child)
  const listed = catalog([], null)
  assert.deepEqual(listed.sources, [])
  assert.ok(listed.warnings.length)
})

test('activity comes from lifecycle events', () => {
  const deepseek = harness('deepseek')
  assert.equal(deepseek.activity({ type: 'turn/start', time: 1, data: { turn: 2 } })?.state, 'working')
  assert.equal(deepseek.activity({ type: 'approval/asked', time: 2, data: {} })?.state, 'waiting')
  assert.equal(
    deepseek.activity({ type: 'turn/end', time: 3, data: { turn: 2, reason: { kind: 'completed' } } })?.state,
    'finished',
  )
  assert.equal(deepseek.activity({ type: 'assistant/message', data: {} }), null)
})

test('a corrupt frame or a future format is reported without hiding healthy sessions', async t => {
  const { put } = setup(t)
  put('healthy', { compressed: true })
  const broken = put('broken', { compressed: true })
  const data = readFileSync(broken)
  data[data.length - 1] ^= 255
  writeFileSync(broken, data)
  put('future', { version: 5 })
  const listed = catalog([], null)
  assert.deepEqual(
    listed.sources.map(source => source.nativeId),
    ['healthy'],
  )
  assert.ok(listed.warnings.length)
})
