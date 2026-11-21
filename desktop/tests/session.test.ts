import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { WebSocketServer } from 'ws'
import { checkpoint, writeHeadless } from '../../shared/terminalCheckpoint'
import { desktopConnectUrl } from '../../shared/desktopAuth'
import { protocolVersion } from '../../shared/protocol'

test('V3 browser sign-in, checkpoint restore, live input, resize and reconnect', { timeout: 20000 }, async t => {
  const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless')
  const terminal = new Terminal({ allowProposedApi: true, cols: 40, rows: 8 })
  writeHeadless(terminal, 'restored history\r\n\x1b[32mwide 界\x1b[0m')
  writeHeadless(terminal, '\x1b[?1049h\x1b[?1006h\x1b]8;;https://example.com/test\x1b\\alt screen\x1b]8;;\x1b\\')
  const parts = [...checkpoint(terminal)]
  const dir = await mkdtemp(join(tmpdir(), 'outpost-native-test-'))
  const login = { account: { id: 'account', name: 'Test', email: null }, expiresAt: Date.now() + 600000 }
  const session = {
    targetId: 'machine',
    sessionId: 'session',
    title: 'Fixture',
    detail: 'Fixture terminal',
    tool: 'codex',
  }
  const credential = 'op_app_' + 'a'.repeat(43)
  let state = '',
    challenge = ''
  const code = 'c'.repeat(43),
    requestId = 'r'.repeat(43)
  const server = createServer(async (req, res) => {
    if (req.url === '/api/desktop/authorizations' || req.url === '/api/desktop/token') {
      let data = ''
      for await (const chunk of req) data += chunk.toString()
      const payload = JSON.parse(data)
      res.setHeader('Content-Type', 'application/json')
      if (req.url.endsWith('authorizations')) {
        state = payload.state
        challenge = payload.challenge
        res.end(JSON.stringify({ requestId }))
      } else {
        assert.equal(payload.code, code)
        assert.equal(createHash('sha256').update(payload.verifier).digest('base64url'), challenge)
        res.end(JSON.stringify({ ...login, token: credential }))
      }
      return
    }
    if (req.headers.authorization !== 'Bearer ' + credential) {
      res.writeHead(401).end()
      return
    }
    let body: unknown
    switch (req.url) {
      case '/api/desktop/account':
        body = login
        break
      case '/api/desktop/targets':
        body = [{ id: 'machine', name: 'Test machine' }]
        break
      case '/api/desktop/targets/machine/sessions':
        body = [session]
        break
      case '/api/desktop/targets/machine/sessions/session/connect':
        body = {
          ...session,
          accountId: 'account',
          loginId: 'desktop:' + randomUUID(),
          server: origin,
          token: 'fixture.grant',
        }
        break
      default:
        res.writeHead(404).end()
        return
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address === 'object')
  const origin = 'http://127.0.0.1:' + address.port
  const ws = new WebSocketServer({ server })
  let connections = 0
  ws.on('connection', (socket, req) => {
    const url = new URL(req.url!, origin)
    assert.equal(req.headers.origin, origin)
    assert.equal(url.searchParams.get('protocol'), String(protocolVersion))
    assert.equal(url.searchParams.get('token'), connections ? 'fixture.resume' : 'fixture.grant')
    assert.equal(url.searchParams.get('start'), connections ? '0' : '1')
    connections++
    const send = (v: unknown) => socket.send(JSON.stringify(v))
    send({ type: 'hello', resume: 'fixture.resume', session: { id: 'session', name: 'Fixture', tool: 'codex' } })
    for (const part of parts) send({ type: 'restore', checkpoint: part })
    send({ type: 'route-selected', route: 'relay' })
    send({ type: 'ready' })
    socket.on('message', (bytes, binary) => {
      if (binary) socket.send(bytes)
      else {
        const m = JSON.parse(bytes.toString())
        if (m.type === 'resize') send({ type: 'geometry', cols: m.cols, rows: m.rows })
      }
    })
  })
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/outpost-helper.cjs', import.meta.url)), dir], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  t.after(async () => {
    child.kill()
    for (const client of ws.clients) client.terminate()
    ws.close()
    server.closeAllConnections()
    server.close()
    terminal.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  const lines = createInterface({ input: child.stdout })
  let linkReceived = false
  let restored = ''
  const cmd = (obj: object) => child.stdin.write(JSON.stringify(obj) + '\n')
  const received = lines[Symbol.asyncIterator]()
  let pane = 0
  async function wait(
    match: (e: {
      event: string
      state: { kind: string }
      sessions: { id: string }[]
      cols: number
      rows: number
    }) => boolean,
  ) {
    for (;;) {
      const item = await received.next()
      assert(!item.done, 'helper exited')
      const e = JSON.parse(item.value)
      assert.notEqual(e.event, 'error', e.message)
      if (e.event === 'links' && e.cells.some((cell: unknown[]) => cell[3] === 'https://example.com/test'))
        linkReceived = true
      if (e.event === 'trust') {
        assert.equal(e.origin, origin)
        cmd({ op: 'answer', id: e.id, answer: true })
      }
      if (e.event === 'browser') {
        assert.equal(e.url, origin + '/desktop/authorize?request=' + requestId)
        cmd({ op: 'link', value: 'outpost://login/' + state + '/' + code })
      }
      if (e.event === 'opened') pane = e.pane
      if (e.event === 'output') restored += Buffer.from(e.data, 'base64').toString()
      if (e.event === 'barrier') cmd({ op: 'ack', pane: e.pane, seq: e.seq })
      if (match(e)) return e
      if (e.event === 'connection' && e.state.kind === 'closed') assert.fail(e.state.message)
    }
  }
  cmd({ op: 'link', value: desktopConnectUrl(origin) })
  const catalogue = await wait(e => e.event === 'accounts' && e.sessions.length > 0)
  cmd({ op: 'choose', value: catalogue.sessions[0].id })
  await wait(e => e.event === 'connection' && e.state.kind === 'connected')
  assert.match(restored, /restored history/)
  assert.match(restored, /wide 界/)
  assert.match(restored, /alt screen/)
  assert.ok(linkReceived)
  assert.equal(JSON.parse(await readFile(join(dir, 'server-logins.json'), 'utf8'))[0].origin, origin)
  cmd({ op: 'input', pane, data: Buffer.from('live input').toString('base64') })
  await wait(e => e.event === 'output' && restored.includes('live input'))
  cmd({ op: 'resize', pane, cols: 50, rows: 12 })
  await wait(e => e.event === 'geometry' && e.cols === 50 && e.rows === 12)
  for (const client of ws.clients) client.terminate()
  await wait(e => e.event === 'connection' && e.state.kind === 'connected')
  assert.equal(connections, 2)
  cmd({ op: 'close', pane })
})
