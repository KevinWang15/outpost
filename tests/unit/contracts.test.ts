// Contracts that exist in both TypeScript and Python, checked against each
// other so a change on one side cannot silently break the other.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { harnesses } from '../../shared/harnesses'
import { RelayDecoder, relayFrame, relayMagic } from '../../backend/terminal/broker'

const root = fileURLToPath(new URL('../../', import.meta.url))
function python(directory: 'runtime', code: string, input?: Buffer) {
  return execFileSync('python3', ['-c', `import json, sys\n${code}`], {
    env: { ...process.env, PYTHONPATH: root + directory, PYTHONDONTWRITEBYTECODE: '1' },
    input,
  })
}
const json = (directory: 'runtime', code: string) => JSON.parse(python(directory, code).toString())

test('coding harnesses: shared/harnesses.ts matches the runtime adapters', () => {
  const adapters = json(
    'runtime',
    `from outpost_harness import adapters
print(json.dumps({tool: {'storage': a.storage_key, 'id': a.id_pattern} for tool, a in adapters().items()}))`,
  )
  assert.deepEqual(Object.keys(adapters).sort(), harnesses.map(harness => harness.id).sort())
  for (const harness of harnesses) {
    assert.equal(adapters[harness.id].storage, harness.storageKey, harness.id)
    assert.equal(`^${adapters[harness.id].id}$`, harness.nativeId, harness.id)
  }
})

test('relay protocol: broker and relay agree on the marker and frames', () => {
  const relay = json(
    'runtime',
    `import outpost_relay as relay
print(json.dumps({'magic': list(relay.MAGIC)}))`,
  )
  assert.deepEqual(Buffer.from(relay.magic), relayMagic)
  // Broker frames decode in Python, split at every byte boundary.
  const frames = Buffer.concat([
    relayFrame('I', Buffer.from([0, 1, 255])),
    relayFrame('C', JSON.stringify({ type: 'resize', cols: 80, rows: 24 })),
  ])
  const output = JSON.parse(
    python(
      'runtime',
      `from outpost_relay import FrameDecoder
data, decoder, frames = sys.stdin.buffer.read(), FrameDecoder(), []
for index in range(len(data)):
    frames += decoder.feed(data[index:index + 1])
print(json.dumps([[kind.decode(), list(payload)] for kind, payload in frames]))`,
      frames,
    ).toString(),
  )
  assert.deepEqual(output, [
    ['I', [0, 1, 255]],
    ['C', [...Buffer.from('{"type":"resize","cols":80,"rows":24}')]],
  ])
  // Relay frames decode in the broker.
  const encoded = python(
    'runtime',
    `import outpost_relay as relay
sys.stdout.buffer.write(relay.encode(b'O', bytes([0, 27, 255])) + relay.control({'type': 'ready'}))`,
  )
  assert.deepEqual(
    new RelayDecoder().feed(encoded).map(frame => [frame.kind, [...frame.payload]]),
    [
      ['O', [0, 27, 255]],
      ['C', [...Buffer.from('{"type":"ready"}')]],
    ],
  )
})
