import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { TerminalSocket, type SocketState } from '../../frontend/terminal/socket'
import type { ServerMessage } from '../../shared/protocol'

class FakeSocket {
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeSocket[] = []
  readyState = 0
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

function setup(t: TestContext) {
  FakeSocket.instances = []
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { href: 'https://outpost.example/terminal' } },
  })
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeSocket })
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 })
  const states: SocketState[] = []
  const client = new TerminalSocket(
    'ticket',
    () => ({ cols: 80, rows: 24 }),
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
    session: { id: 's', name: 'Session' },
  })
  socket.ready()
  client.resume()
  t.mock.timers.tick(7999)
  await settle()
  assert.equal(FakeSocket.instances.length, 1)
  t.mock.timers.tick(1)
  await settle()
  assert.equal(FakeSocket.instances.length, 2)
  assert.equal(FakeSocket.instances[1].url.searchParams.get('token'), 'resume-ticket')
})

for (const reason of ['ended', 'expired', 'outdated'] as const) {
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

test('resume replaces a hung handshake only after its deadline; closing cancels all recovery', async t => {
  const { client } = setup(t)
  client.resume()
  assert.equal(FakeSocket.instances.length, 1)
  t.mock.timers.tick(15_001)
  client.resume()
  assert.equal(FakeSocket.instances.length, 2)
  FakeSocket.instances[1].ready()
  client.resume()
  client.close()
  t.mock.timers.tick(60_000)
  await settle()
  client.resume()
  assert.equal(FakeSocket.instances.length, 2)
})
