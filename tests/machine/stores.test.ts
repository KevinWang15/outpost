// Reading native stores: forward and backward line readers, folds and path confinement.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { confined, foldLines, glob, lines, maxLine, reverseRecords, Scan } from '../../machine/stores'
import { machine } from './fixtures'

const forward = (path: string) =>
  [...lines(path)].flatMap(({ record, end }) => (record ? [{ record, offset: end }] : []))

test('the backward reader yields what the forward reader does, across block boundaries', async t => {
  const home = machine(t)
  const path = join(home, 'transcript.jsonl')
  const parts: string[] = []
  for (let index = 0; index < 400; index++) {
    // Sizes around the 64 KiB block, invalid lines, blank lines and Unicode.
    const size = [1, 70, 65_530, 65_536, 131_000, 3][index % 6]
    if (index % 7 === 3) parts.push('not json')
    if (index % 11 === 5) parts.push('')
    parts.push(JSON.stringify({ index, text: '缓存'.repeat(Math.floor(size / 6)) }))
  }
  writeFileSync(path, parts.join('\n') + '\n{"torn":')
  const end = statSync(path).size
  const expected = forward(path).reverse()
  assert.equal(expected.length, 400)
  assert.deepEqual([...reverseRecords(path, end)], expected)
  // Ending at any record boundary reads only what precedes it.
  const middle = expected[200].offset
  assert.deepEqual([...reverseRecords(path, middle)], expected.slice(200))
})

test('a record larger than a line may be is skipped in both directions', async t => {
  const home = machine(t)
  const path = join(home, 'huge.jsonl')
  writeFileSync(path, '{"before":true}\n' + JSON.stringify({ huge: 'x'.repeat(maxLine + 10) }) + '\n{"after":true}\n')
  assert.deepEqual(
    forward(path).map(item => item.record),
    [{ before: true }, { after: true }],
  )
  assert.deepEqual(
    [...reverseRecords(path, statSync(path).size)].map(item => item.record),
    [{ after: true }, { before: true }],
  )
})

test('a fold reads only what was appended, and starts over when the file is replaced', async t => {
  const home = machine(t)
  const path = join(home, 'fold.jsonl')
  let reads = 0
  const count = () =>
    foldLines(
      `test:${path}`,
      path,
      () => 0,
      (total, record) => (reads++, total + (record.n as number)),
    )
  writeFileSync(path, '{"n":1}\n{"n":2}\n{"n":')
  assert.equal(count(), 3)
  appendFileSync(path, '4}\n')
  assert.equal(count(), 7)
  assert.equal(reads, 3, 'earlier records are not read again')
  writeFileSync(`${path}.new`, '{"n":10}\n')
  renameSync(`${path}.new`, path)
  assert.equal(count(), 10)
})

test('patterns never follow a link out of their store, and sources must be inside it', async t => {
  const home = machine(t)
  const store = join(home, 'store')
  const outside = join(home, 'outside')
  mkdirSync(join(store, 'projects', 'a'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(store, 'projects', 'a', 'one.jsonl'), '{}\n')
  writeFileSync(join(outside, 'secret.jsonl'), '{}\n')
  symlinkSync(outside, join(store, 'projects', 'escape'))
  symlinkSync(join(outside, 'secret.jsonl'), join(store, 'projects', 'a', 'linked.jsonl'))
  assert.deepEqual([...glob(store, 'projects/*/*.jsonl')], [join(store, 'projects', 'a', 'one.jsonl')])
  assert.deepEqual(confined(store, join(store, 'projects', 'a', 'one.jsonl')), ['projects', 'a', 'one.jsonl'])
  assert.throws(() => confined(store, join(outside, 'secret.jsonl')), /outside its store/)
  assert.throws(() => confined(store, join(store, 'projects', 'a', 'linked.jsonl')), /symlinks/)
})

test('a scan counts what it skipped, including a torn final line', async t => {
  const home = machine(t)
  const path = join(home, 'scan.jsonl')
  writeFileSync(path, '{"a":1}\nnot json\n{"b":2}\n{"torn":')
  const scan = new Scan()
  assert.deepEqual([...scan.records(path)], [{ a: 1 }, { b: 2 }])
  assert.equal(scan.skipped, 2)
})
