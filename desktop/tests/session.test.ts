import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { WebSocketServer } from 'ws'
import { checkpoint, writeHeadless } from '../../shared/terminalCheckpoint'
import { desktopEntryUrl, type DesktopLaunch } from '../../shared/desktopAuth'
import { protocolVersion, type ServerMessage } from '../../shared/protocol'
import { ServerAccounts } from '../src/server-accounts'
import { ServerTrust } from '../src/server-trust'
import { ServerLoginStore } from '../src/server-login-store'

test('V3 browser sign-in, terminal restore, foreground completion observation and reconnect', { timeout: 20000 }, t =>
  exerciseSession(t, false),
)
test('quitting during credential persistence drains login and queued preference writes', { timeout: 20000 }, t =>
  exerciseSession(t, true),
)
async function exerciseSession(t: TestContext, quitDuringSave: boolean) {
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
  let credential = 'op_app_' + 'a'.repeat(43)
  let loginId = 'desktop:' + randomUUID()
  let grant = 'fixture.grant'
  const expectedAccounts: Array<string | undefined> = []
  let state = '',
    challenge = ''
  const code = 'c'.repeat(43),
    requestId = 'r'.repeat(43)
  let receivedLogout!: (respond: () => void) => void
  const logoutRequest = new Promise<() => void>(resolve => {
    receivedLogout = resolve
  })
  const server = createServer(async (req, res) => {
    if (req.url === '/api/desktop/authorizations' || req.url === '/api/desktop/token') {
      let data = ''
      for await (const chunk of req) data += chunk.toString()
      const payload = JSON.parse(data)
      res.setHeader('Content-Type', 'application/json')
      if (req.url.endsWith('authorizations')) {
        expectedAccounts.push(payload.accountId)
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
      case '/api/desktop/logout':
        assert.equal(req.method, 'POST')
        receivedLogout(() => res.writeHead(204).end())
        return
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
          title: session.title,
          targetId: session.targetId,
          sessionId: session.sessionId,
          accountId: 'account',
          loginId,
          server: origin,
          token: grant,
        } satisfies DesktopLaunch
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
  const seen: string[] = []
  const finished = (id: string): Extract<ServerMessage, { type: 'activity' }> => ({
    type: 'activity',
    activity: {
      state: 'finished',
      completionId: id,
      observation: 'current',
      detail: null,
      observedAt: null,
      updatedAt: null,
    },
  })
  const png = await readFile(new URL('../../public/outpost-256.png', import.meta.url))
  const file = {
    id: 'f'.repeat(32),
    name: 'sample.png',
    size: png.length,
    source: 'published',
    mediaType: 'image/png',
    createdAt: new Date().toISOString(),
  }
  let reads = 0
  let connections = 0
  ws.on('connection', (socket, req) => {
    const url = new URL(req.url!, origin)
    assert.equal(req.headers.origin, origin)
    assert.equal(url.searchParams.get('protocol'), String(protocolVersion))
    const socketLogin = loginId
    const recovering = connections === 1
    assert.equal(url.searchParams.get('token'), recovering ? 'fixture.resume' : grant)
    assert.equal(url.searchParams.get('start'), recovering ? '0' : '1')
    connections++
    const send = (v: ServerMessage) => socket.send(JSON.stringify(v))
    send({
      type: 'hello',
      resume: 'fixture.resume',
      session: { id: session.sessionId, name: session.title, tool: 'codex' },
      target: { id: session.targetId, name: 'Test machine' },
    })
    for (const part of parts) send({ type: 'restore', checkpoint: part })
    if (connections > 1) send(finished('c'.repeat(64)))
    send({ type: 'ready' })
    socket.on('message', (bytes, binary) => {
      if (binary) socket.send(bytes)
      else {
        const m = JSON.parse(bytes.toString())
        if (m.type === 'activate') send({ type: 'result', id: m.id, ok: socketLogin === loginId && m.token === grant })
        if (m.type === 'acknowledge') {
          seen.push(m.completionId)
          send({ type: 'result', ok: true, id: m.id })
        }
        if (m.type === 'file-read') {
          reads++
          if (reads === 1) send({ type: 'result', id: m.id, ok: false, message: 'Download interrupted' })
          else
            send({
              type: 'result',
              id: m.id,
              ok: true,
              chunk: png.subarray(m.offset, m.offset + 65536).toString('base64'),
            })
        }
        if (m.type === 'resize') send({ type: 'geometry', cols: m.cols, rows: m.rows })
      }
    })
  })
  const preload = quitDuringSave ? ['--import', new URL('./hold-login-write.mjs', import.meta.url).href] : []
  const child = spawn(
    process.execPath,
    [...preload, fileURLToPath(new URL('../dist/outpost-helper.cjs', import.meta.url)), dir],
    {
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  )
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
      activity?: { completionId: string }
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
  cmd({ op: 'link', value: desktopEntryUrl({ server: origin }) })
  if (quitDuringSave) {
    await wait(e => e.event === 'credentialWriteStarted')
    const exited = once(child, 'exit')
    for (const fontSize of [12, 14, 16, 18]) cmd({ op: 'prefs', fontSize, sound: false, localShell: null })
    child.stdin.end()
    assert.deepEqual(await exited, [0, null])
    assert.equal(JSON.parse(await readFile(join(dir, 'server-logins.json'), 'utf8'))[0].token, credential)
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'preferences.json'), 'utf8')), {
      fontSize: 18,
      sound: false,
      localShell: null,
    })
    return
  }
  const catalogue = await wait(e => e.event === 'accounts' && e.sessions.length > 0)
  cmd({ op: 'choose', value: catalogue.sessions[0].id })
  const opened = await wait(e => e.event === 'opened')
  assert.equal(opened.tool, catalogue.sessions[0].tool)
  const metadata = await wait(e => e.event === 'session')
  assert.equal(metadata.tool, session.tool)
  await wait(e => e.event === 'connection' && e.state.kind === 'connected')
  cmd({ op: 'preview', pane, file })
  const failed = await wait(e => e.event === 'previewFailed')
  assert.equal(failed.id, file.id)
  cmd({ op: 'preview', pane, file })
  const preview = await wait(e => e.event === 'preview')
  assert.deepEqual(Buffer.from(preview.data, 'base64'), png)
  const completedReads = reads
  const path = join(dir, 'saved.png')
  cmd({ op: 'saveFile', pane, file, path })
  await wait(e => e.event === 'fileSaved')
  assert.deepEqual(await readFile(path), png)
  assert.equal(reads, completedReads, 'Save uses the bytes already fetched for preview')
  assert.match(restored, /restored history/)
  assert.match(restored, /wide 界/)
  assert.match(restored, /alt screen/)
  assert.ok(linkReceived)
  assert.equal(JSON.parse(await readFile(join(dir, 'server-logins.json'), 'utf8'))[0].origin, origin)
  cmd({ op: 'input', pane, data: Buffer.from('live input').toString('base64') })
  await wait(e => e.event === 'output' && restored.includes('live input'))
  cmd({ op: 'resize', pane, cols: 50, rows: 12 })
  await wait(e => e.event === 'geometry' && e.cols === 50 && e.rows === 12)
  const sync = async (marker: string) => {
    cmd({ op: 'input', pane, data: Buffer.from(marker).toString('base64') })
    await wait(e => e.event === 'output' && restored.includes(marker))
  }
  const display = async (id: string) => {
    ws.clients
      .values()
      .next()
      .value!.send(JSON.stringify(finished(id)))
    return wait(e => e.event === 'activity' && e.activity?.completionId === id)
  }
  const first = 'a'.repeat(64),
    second = 'b'.repeat(64)
  const one = await display(first)
  cmd({ op: 'ack', pane, seq: one.seq })
  cmd({ op: 'resume', pane })
  await sync('background-ready')
  assert.deepEqual(seen, [], 'waking a background pane must not acknowledge it')
  const two = await display(second)
  cmd({ op: 'focus', pane, active: true })
  cmd({ op: 'ack', pane, seq: two.seq })
  await sync('focused-first')
  assert.deepEqual(seen, [first], 'activation acknowledges the completion displayed at that instant')
  cmd({ op: 'observe', pane })
  cmd({ op: 'observe', pane })
  await sync('clicked-second')
  assert.deepEqual(seen, [first, second])
  for (const client of ws.clients) client.terminate()
  const reconnected = await wait(e => e.event === 'activity' && e.activity?.completionId === 'c'.repeat(64))
  cmd({ op: 'ack', pane, seq: reconnected.seq })
  await wait(e => e.event === 'connection' && e.state.kind === 'connected')
  await sync('viewed-reconnect')
  assert.deepEqual(seen, [first, second, 'c'.repeat(64)])
  assert.equal(connections, 2)
  const link = desktopEntryUrl({
    server: origin,
    accountId: login.account.id,
    session: { targetId: session.targetId, sessionId: session.sessionId },
  })
  cmd({ op: 'link', value: link })
  assert.equal((await wait(e => e.event === 'select')).pane, opened.pane)
  assert.equal(connections, 2, 'opening a session with its current login keeps the live socket')

  // The old socket may still be open when browser approval renews the app login.
  credential = 'op_app_' + 'b'.repeat(43)
  loginId = 'desktop:' + randomUUID()
  grant = 'renewed.grant'
  cmd({ op: 'link', value: link })
  const renewed = await wait(e => e.event === 'connection' && e.state.kind === 'connected')
  assert.equal(renewed.pane, opened.pane)
  assert.equal(connections, 3, 'the renewed login opens a fresh attachment in the same pane')
  assert.deepEqual(expectedAccounts, [undefined, login.account.id])
  await sync('renewed-login')
  cmd({ op: 'logout', origin })
  const removed = await wait(e => e.event === 'paneRemoved')
  assert.equal(removed.pane, pane)
  const empty = await wait(e => e.event === 'accounts' && !e.sessions.length)
  assert.deepEqual(empty.accounts, [])
  assert.deepEqual(empty.recent, [])
  // The pane and login are gone even though the server hasn't answered.
  const finishLogout = await logoutRequest
  finishLogout()
  for (const file of ['server-logins.json', 'server-trust.json', 'recent-sessions.json'])
    assert.deepEqual(JSON.parse(await readFile(join(dir, file), 'utf8')), [])
}

test('repeated machine requests notify desktop windows only when the account state changes', async t => {
  const origin = 'https://outpost.example'
  const dir = await mkdtemp(join(tmpdir(), 'outpost-account-status-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const trust = new ServerTrust(join(dir, 'trust.json'), async () => true)
  await trust.ensure(origin)
  const path = join(dir, 'logins.json')
  await new ServerLoginStore(path).put({
    origin,
    token: 'op_app_' + 'a'.repeat(43),
    account: { id: 'account', name: 'Fixture', email: null },
    expiresAt: Date.now() + 600_000,
  })
  const changes: Array<[string, string | null]> = []
  const accounts = new ServerAccounts(path, trust, {
    openBrowser: async () => assert.fail('unexpected sign-in'),
    failed: error => assert.fail(error),
    changed: () => {
      const { status, error } = accounts.snapshot().accounts[0]
      changes.push([status, error])
    },
  })
  t.after(() => accounts.dispose())
  await accounts.load()
  let failure = ''
  t.mock.method(globalThis, 'fetch', async () => {
    if (failure) throw new Error(failure)
    return Response.json([])
  })
  const list = () => accounts.creationServers()[0].targets(AbortSignal.timeout(1000))
  await list()
  await list()
  failure = 'Server unreachable'
  await assert.rejects(list, /Server unreachable/)
  await assert.rejects(list, /Server unreachable/)
  failure = 'Connection reset'
  await assert.rejects(list, /Connection reset/)
  failure = ''
  await list()
  assert.deepEqual(changes, [
    ['connected', null],
    ['offline', 'Server unreachable'],
    ['offline', 'Connection reset'],
    ['connected', null],
  ])
})

test('sign-out clears only the selected server when revocation fails', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'outpost-forget-server-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const trust = new ServerTrust(join(dir, 'trust.json'), async () => true)
  const path = join(dir, 'logins.json')
  const store = new ServerLoginStore(path)
  const origins = ['https://retired.example', 'https://keep.example']
  for (const origin of origins) {
    await trust.ensure(origin)
    await store.put({
      origin,
      token: 'op_app_' + 'a'.repeat(43),
      account: { id: 'account', name: 'Test', email: null },
      expiresAt: Date.now() + 600000,
    })
  }
  const accounts = new ServerAccounts(path, trust, {
    changed() {},
    failed: assert.fail,
    openBrowser: async () => assert.fail(),
  })
  await accounts.load()
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Server offline')
  })
  await Promise.all([accounts.logout(origins[0]), accounts.logout(origins[0])])
  assert.equal(network.mock.callCount(), 1)
  const restored = new ServerLoginStore(path)
  await restored.load(() => true)
  assert.deepEqual(
    restored.list().map(x => x.origin),
    [origins[1]],
  )
  const restoredTrust = new ServerTrust(join(dir, 'trust.json'), async () => false)
  await restoredTrust.load()
  assert.equal(await restoredTrust.ensure(origins[0]), false)
  assert.equal(restoredTrust.has(origins[1]), true)
  accounts.dispose()
})
