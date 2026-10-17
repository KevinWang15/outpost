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
  const states: TerminalState[] = []
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
    session: { id: 's', name: 'Session' },
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
    session: { id: 's', name: 'Session' },
    target: { id: 't', name: 'Target' },
  })
  socket.ready()
}
const screenshot = () =>
  new File([new Uint8Array([137, 80, 78, 71, 0, 255, 13, 10, 32])], 'screen.png', { type: 'image/png' })
const flushPromises = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

test('image upload sends the File as binary with resume authorization, then pastes once without Enter', async t => {
  const { client, socket } = setup(t)
  readyForImages(socket)
  const file = screenshot()
  const upload = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/terminal/image')
    assert.equal(options!.body, file)
    assert.equal(options!.credentials, 'omit')
    assert.deepEqual(options!.headers, {
      authorization: 'Bearer image-resume',
      'x-outpost-request': '1',
      'content-type': 'image/png',
    })
    return Response.json({ path: '/image.png', reference: '/image.png' })
  })
  const work = client.pasteImage(file)
  await flushPromises()
  const paste = socket.requests().filter(message => message.type === 'paste')
  assert.equal(paste.length, 1)
  assert.equal(paste[0].data, '/image.png')
  socket.message({ type: 'result', id: paste[0].id, ok: true })
  assert.equal(await work, '/image.png')
  assert.equal(upload.mock.callCount(), 1)
  assert.equal(socket.sent.filter(message => typeof message !== 'string').length, 0)
})

test('a pending image upload cannot block interactive input or accept another image', async t => {
  const { client, socket } = setup(t)
  readyForImages(socket)
  let finish!: (response: Response) => void
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    () =>
      new Promise<Response>(resolve => {
        finish = resolve
      }),
  )
  const upload = client.pasteImage(screenshot())
  await assert.rejects(client.pasteImage(screenshot()), /previous image/)
  assert.equal(client.input('typing while uploading'), true)
  assert.ok(
    socket.sent.some(
      message => message instanceof Uint8Array && new TextDecoder().decode(message) === 'typing while uploading',
    ),
  )
  finish(Response.json({ path: '/x.png', reference: '/x.png' }))
  await flushPromises()
  const paste = socket.requests().find(message => message.type === 'paste')!
  socket.message({ type: 'result', id: paste.id, ok: true })
  await upload
  assert.equal(fetch.mock.callCount(), 1)
})

test('disconnect aborts an upload and a late response cannot paste into its replacement', async t => {
  const { client, socket } = setup(t)
  readyForImages(socket)
  let finish!: (response: Response) => void
  let signal!: AbortSignal
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    signal = options!.signal as AbortSignal
    return new Promise<Response>(resolve => {
      finish = resolve
    })
  })
  const work = client.pasteImage(screenshot())
  const rejected = assert.rejects(work, /disconnected/)
  socket.close()
  await flushPromises()
  assert.equal(signal.aborted, true)
  client.reconnect()
  const next = FakeSocket.instances.at(-1)!
  readyForImages(next)
  finish(Response.json({ path: '/late.png', reference: '/late.png' }))
  await rejected
  assert.equal(socket.requests().filter(message => message.type === 'paste').length, 0)
  assert.equal(next.requests().filter(message => message.type === 'paste').length, 0)
})

test('upload errors and timeouts preserve the live terminal and allow another image', async t => {
  const { client, socket } = setup(t)
  readyForImages(socket)
  const mock = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ message: 'Image rejected' }, { status: 413 }),
  )
  await assert.rejects(client.pasteImage(screenshot()), /Image rejected/)
  mock.mock.mockImplementation(async () => Response.json({ path: '/bad.png' }))
  await assert.rejects(client.pasteImage(screenshot()), /image reference/)
  mock.mock.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true })
      }),
  )
  const timedOut = assert.rejects(client.pasteImage(screenshot()), /timed out/)
  t.mock.timers.tick(150_000)
  await timedOut
  assert.equal(client.connected, true)
  assert.equal(socket.requests().filter(message => message.type === 'paste').length, 0)
})

test('a lost paste acknowledgement never causes an automatic second insertion', async t => {
  const { client, socket } = setup(t)
  readyForImages(socket)
  t.mock.method(globalThis, 'fetch', async () => Response.json({ path: '/x.png', reference: '/x.png' }))
  const rejected = assert.rejects(client.pasteImage(screenshot()), /did not confirm/)
  await flushPromises()
  t.mock.timers.tick(60_000)
  await rejected
  assert.equal(socket.requests().filter(message => message.type === 'paste').length, 1)
})
