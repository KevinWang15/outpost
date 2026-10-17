import assert from 'node:assert/strict'
import test from 'node:test'
import { LocalTerminalConnection } from '../../frontend/terminal/local'
import type { LocalTerminalBridge, LocalTerminalEvent } from '../../shared/localTerminal'
import { imageProblem, imageMediaTypes, maxImageBytes } from '../../shared/images'

function local() {
  let receive: (event: LocalTerminalEvent) => void = () => {}
  const bridge: LocalTerminalBridge = {
    onEvent: listener => {
      receive = listener
      return () => {
        receive = () => {}
      }
    },
    start: async (generation, cols, rows) => receive({ type: 'ready', generation, cols, rows, name: 'Shell' }),
    write: async () => {},
    resize: async () => {},
    acknowledge: () => {},
    stop: async () => {},
    pasteImage: async () => '/image.png',
  }
  const client = new LocalTerminalConnection(
    bridge,
    () => ({ cols: 80, rows: 24 }),
    {
      begin: () => {},
      output: (_bytes, rendered) => rendered(),
      restore: (_message, rendered) => rendered(),
      flush: rendered => rendered(),
    },
    () => {},
    () => {},
    () => {},
  )
  client.open()
  return { bridge, client }
}

test('local image delivery uses binary IPC and the current shell generation, without HTTP', async t => {
  const { bridge, client } = local()
  t.after(() => client.close())
  const paste = t.mock.method(bridge, 'pasteImage')
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Local images cannot use HTTP')
  })
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 255, 13, 10])
  assert.equal(await client.pasteImage(new File([bytes], 'image.png', { type: 'image/png' })), '/image.png')
  assert.equal(paste.mock.callCount(), 1)
  const [generation, data, type] = paste.mock.calls[0].arguments
  assert.match(generation, /^[a-f0-9-]{36}$/)
  assert.deepEqual(data, bytes)
  assert.equal(type, 'image/png')
  assert.equal(fetch.mock.callCount(), 0)
})

test('a local image read finishing after a shell restart cannot enter the new shell', async t => {
  const { bridge, client } = local()
  t.after(() => client.close())
  const paste = t.mock.method(bridge, 'pasteImage')
  const file = new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' })
  let finish!: (data: ArrayBuffer) => void
  t.mock.method(
    file,
    'arrayBuffer',
    () =>
      new Promise<ArrayBuffer>(resolve => {
        finish = resolve
      }),
  )
  const work = client.pasteImage(file)
  const rejected = assert.rejects(work, /shell changed/)
  client.open()
  finish(new ArrayBuffer(4))
  await rejected
  assert.equal(paste.mock.callCount(), 0)
  assert.equal(client.connected, true)
})

test('shared image validation accepts the four formats up to 16 MiB and rejects empty, oversized or other files', () => {
  for (const type of imageMediaTypes) {
    assert.equal(imageProblem({ type, size: 1 }), null)
    assert.equal(imageProblem({ type, size: maxImageBytes }), null)
  }
  for (const size of [0, -1, 0.5, Infinity, NaN, maxImageBytes + 1])
    assert.match(imageProblem({ type: 'image/png', size })!, /between/)
  for (const type of ['', 'text/plain', 'image/svg+xml', 'application/octet-stream'])
    assert.match(imageProblem({ type, size: 50 })!, /not a PNG/)
})
