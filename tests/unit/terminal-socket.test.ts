import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { TerminalSocket } from '../../frontend/terminal/socket'
import type { TerminalState } from '../../frontend/terminal/connection'
import type { ServerMessage } from '../../shared/protocol'
import { terminalConnectionPolicy } from '../../shared/protocol'

class FakeSocket {
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeSocket[] = []
  readyState = 0
  bufferedAmount = 0
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  sent: (string | Uint8Array)[] = []
  constructor(public url: URL) {
    FakeSocket.instances.push(this)
  }
  send(data: string | Uint8Array) {
    this.sent.push(data)
  }
  message(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  close() {
    this.readyState = FakeSocket.CLOSED
    // Real WebSocket close callbacks are asynchronous.
    queueMicrotask(() => this.onclose?.())
  }
  ready() {
    this.readyState = FakeSocket.OPEN
    this.message({ type: 'ready' })
  }
  requests() {
    return this.sent.filter((data): data is string => typeof data === 'string').map(data => JSON.parse(data))
  }
}

function setup(
  t: TestContext,
  size: () => { cols: number; rows: number } | undefined = () => ({ cols: 80, rows: 24 }),
) {
  FakeSocket.instances = []
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { href: 'https://outpost.example/terminal' } },
  })
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeSocket })
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 })
  const states: TerminalState[] = []
  const client = new TerminalSocket(
    'ticket',
    size,
    {
      begin: () => {},
      output: (_bytes, rendered) => rendered(),
      restore: (_message, rendered) => rendered(),
      flush: rendered => rendered(),
    },
    {
      state: state => states.push(state),
      hello: () => {},
      signal: () => {},
      activity: () => {},
      deliveries: () => {},
    },
  )
  t.after(() => {
    client.close()
    for (const [key, descriptor] of [
      ['window', originalWindow],
      ['WebSocket', originalSocket],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  client.open()
  return { client, states, socket: FakeSocket.instances[0] }
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test('a connection waits for its first measured grid, including an actual 80 by 24 pane', t => {
  const viewport: { measured?: { cols: number; rows: number } } = {}
  const { client } = setup(t, () => viewport.measured)
  client.resume()
  assert.equal(FakeSocket.instances.length, 0)
  viewport.measured = { cols: 80, rows: 24 }
  client.resize(viewport.measured.cols, viewport.measured.rows)
  client.resize(viewport.measured.cols, viewport.measured.rows)
  assert.equal(FakeSocket.instances.length, 1)
  const { searchParams } = FakeSocket.instances[0].url
  assert.equal(searchParams.get('cols'), '80')
  assert.equal(searchParams.get('rows'), '24')
})

test('closing an unmeasured pane prevents a late measurement from starting a session', t => {
  const viewport: { measured?: { cols: number; rows: number } } = {}
  const { client } = setup(t, () => viewport.measured)
  client.close()
  viewport.measured = { cols: 110, rows: 38 }
  client.resize(viewport.measured.cols, viewport.measured.rows)
  assert.equal(FakeSocket.instances.length, 0)
})

test('large restoration batches acknowledgements and preserves their exact byte count', t => {
  const { socket } = setup(t)
  socket.ready()
  const message: ServerMessage = { type: 'restore', checkpoint: { part: 'end' } }
  for (let index = 0; index < 2000; index++) socket.message(message)
  t.mock.timers.tick(20)
  const acks = socket.requests().filter(message => message.type === 'ack')
  assert.ok(acks.length < 10, `Unexpected acknowledgement burst: ${acks.length}`)
  assert.equal(
    acks.reduce((sum, ack) => sum + ack.bytes, 0),
    Buffer.byteLength(JSON.stringify(message)) * 2000,
  )
})

test('render failures show a closed state and allow explicit reconnection', t => {
  const { client, socket, states } = setup(t)
  socket.ready()
  client.fail('Invalid checkpoint')
  assert.deepEqual(states.at(-1), { kind: 'closed', reason: 'error', message: 'Invalid checkpoint' })
  assert.equal(client.connected, false)
  client.reconnect()
  FakeSocket.instances[1].ready()
  assert.equal(client.connected, true)
})

test('resume coalesces probes, retains a healthy socket, and never sends ping bytes to the process', async t => {
  const { client, socket } = setup(t)
  socket.ready()
  client.resume()
  client.resume()
  client.resume()
  const pings = socket.requests().filter(message => message.type === 'ping')
  assert.equal(pings.length, 1)
  socket.message({ type: 'result', id: pings[0].id, ok: true })
  await settle()
  t.mock.timers.tick(9000)
  await settle()
  assert.equal(FakeSocket.instances.length, 1)
  assert.equal(socket.sent.filter(data => typeof data !== 'string').length, 0)
  client.resume()
  assert.equal(socket.requests().filter(message => message.type === 'ping').length, 2)
})

test('a stale open socket is replaced after the probe deadline, preserving its resume grant', async t => {
  const { client, socket } = setup(t)
  socket.message({
    type: 'hello',
    resume: 'resume-ticket',
    target: { id: 't', name: 'Box' },
    session: { id: 's', name: 'Session', tool: 'claude' },
  })
  socket.ready()
  client.resume()
  t.mock.timers.tick(terminalConnectionPolicy.wakeProbeMs - 1)
  await settle()
  assert.equal(FakeSocket.instances.length, 1)
  t.mock.timers.tick(1)
  await settle()
  t.mock.timers.tick(1000)
  assert.equal(FakeSocket.instances.length, 2)
  assert.equal(FakeSocket.instances[1].url.searchParams.get('token'), 'resume-ticket')
  assert.equal(socket.url.searchParams.get('start'), '1')
  assert.equal(FakeSocket.instances[1].url.searchParams.get('start'), '0')
  FakeSocket.instances[1].message({ type: 'closed', reason: 'ended', message: 'Exited while away' })
  client.reconnect()
  assert.equal(FakeSocket.instances[2].url.searchParams.get('start'), '1')
})

for (const reason of ['ended', 'expired', 'outdated', 'unavailable'] as const) {
  test(`returning to a ${reason} session does not reconnect automatically`, async t => {
    const { client, socket, states } = setup(t)
    socket.ready()
    client.resume()
    socket.message({ type: 'closed', reason, message: reason })
    socket.close()
    await settle()
    client.resume()
    t.mock.timers.tick(60_000)
    await settle()
    assert.equal(FakeSocket.instances.length, 1)
    assert.deepEqual(states.at(-1), { kind: 'closed', reason, message: reason })
  })
}

test('returning online bypasses backoff but does not create duplicate connections', async t => {
  const { client, socket } = setup(t)
  socket.ready()
  socket.close()
  await settle()
  client.resume()
  client.resume()
  assert.equal(FakeSocket.instances.length, 2)
  t.mock.timers.tick(10_000)
  await settle()
  assert.equal(FakeSocket.instances.length, 2)
})

test('a hung handshake expires automatically; closing cancels all recovery', async t => {
  const { client } = setup(t)
  client.resume()
  assert.equal(FakeSocket.instances.length, 1)
  t.mock.timers.tick(terminalConnectionPolicy.clientAttachMs)
  t.mock.timers.tick(1000)
  assert.equal(FakeSocket.instances.length, 2)
  FakeSocket.instances[1].ready()
  client.resume()
  client.close()
  t.mock.timers.tick(60_000)
  await settle()
  client.resume()
  assert.equal(FakeSocket.instances.length, 2)
})

test('transient failures keep retrying beyond the old limit with capped backoff', async t => {
  const { client, states } = setup(t)
  for (let attempt = 0; attempt < 60; attempt++) {
    FakeSocket.instances.at(-1)!.close()
    await settle()
    assert.equal(states.at(-1)?.kind, 'reconnecting')
    t.mock.timers.tick(terminalConnectionPolicy.retryMaxMs)
    assert.equal(FakeSocket.instances.length, attempt + 2)
  }
  FakeSocket.instances.at(-1)!.ready()
  assert.equal(client.connected, true)
})

test('offline retries pause for hours and returning online opens exactly one attachment', async t => {
  const { client, socket, states } = setup(t)
  socket.ready()
  socket.close()
  await settle()
  client.networkChanged(false)
  t.mock.timers.tick(4 * 60 * 60_000)
  assert.equal(FakeSocket.instances.length, 1)
  assert.match((states.at(-1) as { message: string }).message, /Waiting for a network/)
  client.networkChanged(true)
  client.networkChanged(true)
  client.resume()
  assert.equal(FakeSocket.instances.length, 2)
  FakeSocket.instances[1].ready()
  assert.equal(client.connected, true)
})

test('an offline OS hint does not tear down a working connection to a local server', async t => {
  const { client, socket } = setup(t)
  socket.ready()
  client.networkChanged(false)
  t.mock.timers.tick(terminalConnectionPolicy.heartbeatMs)
  const ping = socket.requests().find(message => message.type === 'ping')!
  socket.message({ type: 'result', id: ping.id, ok: true })
  assert.equal(client.connected, true)
  assert.equal(FakeSocket.instances.length, 1)
})

test('periodic probes detect a half-open idle connection without any focus or network events', t => {
  const { socket } = setup(t)
  socket.ready()
  for (let index = 0; index < 6; index++) {
    t.mock.timers.tick(terminalConnectionPolicy.heartbeatMs)
    const pings = socket.requests().filter(message => message.type === 'ping')
    assert.equal(pings.length, index + 1)
    socket.message({ type: 'result', id: pings.at(-1).id, ok: true })
  }
  t.mock.timers.tick(terminalConnectionPolicy.heartbeatMs)
  t.mock.timers.tick(terminalConnectionPolicy.probeMs)
  t.mock.timers.tick(1000)
  assert.equal(FakeSocket.instances.length, 2)
})

test('wake shortens an existing periodic probe; event bursts cannot extend its deadline', t => {
  const { client, socket } = setup(t)
  socket.ready()
  t.mock.timers.tick(terminalConnectionPolicy.heartbeatMs)
  client.resume()
  for (let seconds = 0; seconds < 5; seconds++) {
    t.mock.timers.tick(1000)
    if (seconds < 4) client.resume()
  }
  t.mock.timers.tick(1000)
  assert.equal(socket.requests().filter(message => message.type === 'ping').length, 1)
  assert.equal(FakeSocket.instances.length, 2)
})

test('wake replaces a handshake suspended for hours and ignores late events from its old socket', t => {
  const { client, socket } = setup(t)
  socket.readyState = FakeSocket.OPEN
  socket.message({
    type: 'hello',
    resume: 'sleep-resume',
    target: { id: 't', name: 'Target' },
    session: { id: 's', name: 'Session', tool: 'claude' },
  })
  const lateMessage = socket.onmessage!
  t.mock.timers.setTime(Date.now() + 4 * 60 * 60_000)
  client.resume()
  client.resume()
  const next = FakeSocket.instances[1]
  assert.equal(FakeSocket.instances.length, 2)
  assert.equal(next.url.searchParams.get('token'), 'sleep-resume')
  next.ready()
  lateMessage({ data: JSON.stringify({ type: 'closed', reason: 'expired', message: 'stale' }) })
  assert.equal(client.connected, true)
})

test('closing during offline recovery cancels future network and wake attempts', async t => {
  const { client, socket } = setup(t)
  socket.ready()
  client.networkChanged(false)
  socket.close()
  await settle()
  client.close()
  client.networkChanged(true)
  client.resume()
  t.mock.timers.tick(4 * 60 * 60_000)
  assert.equal(FakeSocket.instances.length, 1)
})

function readyForImages(socket: FakeSocket) {
  socket.message({
    type: 'hello',
    resume: 'image-resume',
    session: { id: 's', name: 'Session', tool: 'claude' },
    target: { id: 't', name: 'Target' },
  })
  socket.ready()
}
const screenshot = () =>
  new File([new Uint8Array([137, 80, 78, 71, 0, 255, 13, 10, 32])], 'screen.png', { type: 'image/png' })
test('published file bytes come back on the connected socket, alongside PTY input', async t => {
  const { client, socket } = setup(t)
  socket.ready()
  const bytes = Buffer.alloc(64 * 1024 + 7, 0xa5)
  bytes.fill(0x3b, 65536)
  const file = {
    id: 'a'.repeat(32),
    name: 'report.bin',
    createdAt: new Date().toISOString(),
    size: bytes.length,
    source: 'published' as const,
    mediaType: 'application/octet-stream' as const,
  }
  const progress: number[] = []
  const result = client.readFile(file, new AbortController().signal, count => progress.push(count))
  await settle()
  const [first, second] = socket.requests().filter(m => m.type === 'file-read')
  assert.equal(first.file, file.id)
  assert.equal(first.offset, 0)
  assert.equal(second.offset, 65536)
  assert.ok(client.input('x'))
  socket.message({ type: 'result', id: second.id, ok: true, chunk: bytes.subarray(65536).toString('base64') })
  socket.message({ type: 'result', id: first.id, ok: true, chunk: bytes.subarray(0, 65536).toString('base64') })
  assert.deepEqual(Buffer.from(await (await result).arrayBuffer()), bytes)
  assert.deepEqual(progress, [7, bytes.length])
})

test('image bytes, their acknowledgement and a single paste use the same terminal socket', async t => {
  const { client, socket } = setup(t)
  socket.ready()
  const bytes = Buffer.alloc(65537, 0xb5)
  const pasted = client.pasteImage(new File([bytes], 'image.png', { type: 'image/png' }))
  const seen: Buffer[] = []
  // File.arrayBuffer() resolves on a later Node turn.
  for (let index = 0; index < 2; index++) {
    await new Promise<void>(resolve => setImmediate(resolve))
    const request = socket.requests().filter(m => m.type === 'image-write')[index]
    assert.equal(request.offset, index * 65536)
    seen.push(Buffer.from(request.chunk, 'base64'))
    socket.message({
      type: 'result',
      id: request.id,
      ok: true,
    })
  }
  await settle()
  assert.deepEqual(Buffer.concat(seen), bytes)
  const insertions = socket.requests().filter(m => m.type === 'image-paste')
  assert.equal(insertions.length, 1)
  assert.equal(insertions[0].mode, 'attachment')
  assert.equal(insertions[0].transfer, socket.requests().find(m => m.type === 'image-write').transfer)
  socket.message({ type: 'result', id: insertions[0].id, ok: true })
  await pasted
})

test('a disconnected image upload cannot paste into a replacement attachment', async t => {
  const { client, socket } = setup(t)
  readyForImages(socket)
  const pending = client.pasteImage(screenshot())
  await new Promise<void>(resolve => setImmediate(resolve))
  const chunk = socket.requests().find(m => m.type === 'image-write')
  assert.ok(chunk)
  await assert.rejects(client.pasteImage(screenshot()), /previous image/)
  assert.ok(client.input('during upload'))
  client.close()
  await assert.rejects(pending)
  socket.message({ type: 'result', id: chunk.id, ok: true })
  assert.equal(socket.requests().filter(m => m.type === 'image-paste').length, 0)
})

test('a lost paste acknowledgement does not replay input', async t => {
  const { client, socket } = setup(t)
  readyForImages(socket)
  const pending = client.pasteImage(screenshot())
  await new Promise<void>(resolve => setImmediate(resolve))
  const write = socket.requests().find(m => m.type === 'image-write')
  socket.message({ type: 'result', id: write.id, ok: true })
  await settle()
  assert.equal(socket.requests().filter(m => m.type === 'image-paste').length, 1)
  client.reconnect()
  await assert.rejects(pending)
  const replacement = FakeSocket.instances.at(-1)!
  readyForImages(replacement)
  assert.ok(!replacement.requests().some(m => m.type === 'image-paste' || m.type === 'image-write'))
})
