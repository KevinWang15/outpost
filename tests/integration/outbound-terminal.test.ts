import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { WebSocket as Peer } from 'ws'
import { createApp } from '../../backend/app'
import { LocalDeployment } from '../../backend/deployment'
import { TerminalSocket } from '../../frontend/terminal/socket'
import { filesChanged } from '../../machine/commands'
import { publish } from '../../machine/files'
import { state } from '../../machine/state'
import { record, register } from '../machine/fixtures'
import { fakeSoftware } from '../unit/fakes'
import { exerciseMachineChat } from './machine-chat'
import { api, fixtureHome, terminalBinary } from './helpers'

const bun = process.platform !== 'linux' && process.env.TEST_BUN
const program = bun || process.env.TEST_TERMINAL || terminalBinary
async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return
    await delay(50)
  }
  assert.fail('Timed out waiting for the outbound terminal')
}

test(
  'outbound enrollment, terminal, two-way files, reconnect and revocation',
  {
    skip: !existsSync(program) || (process.platform !== 'linux' && !bun && !process.env.TEST_TERMINAL),
    timeout: 165_000,
  },
  async t => {
    const fixture = process.platform === 'linux' ? await fixtureHome('op-out-') : null
    const home = fixture?.home ?? (await mkdtemp('/tmp/op-out-'))
    const previous = state.directory
    state.directory = join(home, '.outpost')
    const cleanup: (() => void | Promise<void>)[] = []
    t.after(async () => {
      try {
        for (const action of cleanup.reverse()) await action()
      } finally {
        state.directory = previous
        await rm(fixture?.directory ?? home, { recursive: true, force: true })
      }
    })
    const run = (...args: string[]) => {
      const child = spawn(program, [...(bun ? [resolve('machine/main.ts')] : []), ...args], {
        env: fixture?.env ?? { ...process.env, HOME: home },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      child.stdout.resume()
      child.stderr.resume()
      const exited = once(child, 'exit')
      cleanup.push(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
          await exited
        }
      })
      return child
    }
    await mkdir(join(state.directory, 'terminals'), { recursive: true })
    const session = record(home, 'codex', randomUUID())
    await register(session)
    const service = run('serve')
    const path = 'terminals/' + session.id + '.sock'
    service.stdin.end(
      JSON.stringify({
        socket: path,
        session: session.id,
        revision: 1,
        conversation: session.conversations[0].id,
        command: ['/bin/cat'],
        env: { HOME: home, PATH: '/bin:/usr/bin' },
        cwd: home,
        cols: 80,
        rows: 24,
      }),
    )
    await waitFor(() => existsSync(join(state.directory, path)))
    const app = await createApp({
      deployment: await LocalDeployment.open(join(home, 'server')),
      ...(fixture ? {} : { software: fakeSoftware }),
      history: false,
    })
    let dropEnrollmentReply = true
    let acceptedRequests = 0
    app.addHook('onSend', async (request, reply, payload) => {
      if (request.url === '/api/machine/enroll' && reply.statusCode === 200) {
        acceptedRequests++
        if (dropEnrollmentReply) {
          dropEnrollmentReply = false
          reply.hijack()
          reply.raw.destroy()
        }
      }
      return payload
    })
    let link: Duplex | undefined
    let registrations = 0
    app.server.on('upgrade', (req, socket) => {
      if (req.url === '/api/machine/connect') {
        registrations++
        link = socket
      }
    })
    const origin = await app.listen({ host: '127.0.0.1', port: 0 })
    cleanup.push(() => app.close())
    const call = api(origin)
    const { id } = await call<{ id: string }>('POST', '/targets', { kind: 'outbound', name: 'Workstation' }, 201)
    const base = '/targets/' + id
    const { code } = await call<{ code: string }>('POST', base + '/enrollment')
    const enroll = async (target: string, code: string) => {
      const child = run('enroll', 'outbound', origin, target)
      child.stdin.end(code + '\n')
      return (await once(child, 'close'))[0]
    }
    assert.equal(await enroll(id, code), 1)
    assert.equal((await call<{ enrolled: boolean }>('GET', base + '/enrollment')).enrolled, true)
    const status = run('status')
    const output: Buffer[] = []
    status.stdout.on('data', chunk => output.push(chunk))
    assert.equal((await once(status, 'close'))[0], 0)
    assert.match(Buffer.concat(output).toString(), /Enrollment pending/)
    assert.equal((await once(run('connect'), 'close'))[0], 1)
    assert.equal((await once(run('enroll', 'ssh', 'run/node-' + 'a'.repeat(32) + '.sock'), 'close'))[0], 1)
    assert.equal(await enroll(randomUUID(), code), 1)
    assert.equal(await enroll(id, code), 0)
    assert.equal(await enroll(id, code), 0)
    assert.equal(acceptedRequests, 2)
    await call('POST', '/machine/enroll', { targetId: id, code, secret: randomBytes(32).toString('base64url') }, 401)
    const connector = run('connect')
    await waitFor(async () => (await fetch(origin + '/api' + base + '/sessions')).ok)
    const { token } = await call<{ token: string }>('POST', base + '/sessions/' + session.id + '/connect', {})
    const bytes = await readFile(resolve('public/outpost-256.png'))
    const received: Buffer[] = []
    let changes = 0
    const client = new TerminalSocket(
      token,
      () => ({ cols: 80, rows: 24 }),
      {
        begin() {},
        restore(_message, done) {
          done()
        },
        output(data, done) {
          received.push(Buffer.from(data))
          done()
        },
        flush(done) {
          done()
        },
      },
      {
        state() {},
        activity() {},
        hello() {},
        deliveries() {},
        signal(message) {
          if (message.signal.type === 'files.changed') changes++
        },
      },
      {
        origin,
        open: url => {
          assert.equal(url.host, new URL(origin).host)
          return new Peer(url, { origin }) as unknown as WebSocket
        },
      },
    )
    cleanup.push(() => client.close())
    client.open()
    await waitFor(() => client.connected)
    assert.equal(client.input('over-outpost\n'), true)
    await waitFor(() => Buffer.concat(received).includes('over-outpost'))
    const file = await publish(session.id, resolve('public/outpost-256.png'))
    await filesChanged(session.id, 'terminal', file)
    await waitFor(() => changes === 1)
    // A plain cat process has no image shortcut; its explicit path paste remains useful.
    await client.pasteImage(new File([bytes], 'image.png', { type: 'image/png' }), 'path')
    const pastedPath = () =>
      Buffer.concat(received)
        .toString()
        .match(/(\/[^\r\n]*?\/clipboard\/[^\r\n]*?\.png)/)?.[1]
    await waitFor(() => Boolean(pastedPath()))
    assert.deepEqual(await readFile(pastedPath()!), bytes)
    assert.ok(link)
    link.destroy()
    await waitFor(() => registrations >= 2 && client.connected)
    // The result may be published between attachments and must remain on the machine.
    await waitFor(async () => {
      try {
        return (await client.listFiles(AbortSignal.timeout(2000))).some(item => item.id === file.id)
      } catch {
        return false
      }
    })
    assert.deepEqual(Buffer.from(await (await client.readFile(file, AbortSignal.timeout(5000))).arrayBuffer()), bytes)
    assert.equal(service.exitCode, null)
    if (fixture) {
      await waitFor(async () => {
        const { installation } = await call<{ installation: { status: string; error?: string } }>(
          'GET',
          base + '/installations',
        )
        assert.notEqual(installation?.status, 'failed', installation?.error ?? 'Machine setup failed')
        return installation?.status === 'succeeded'
      })
      const agent = await call<{ id: string }>(
        'POST',
        base + '/sessions',
        { name: 'ACP', rootDir: '~/qa', createDirectory: true, tool: 'claude' },
        201,
      )
      await exerciseMachineChat(origin, { targetId: id, sessionId: agent.id })
    }
    await call('DELETE', base, undefined, 204)
    await waitFor(() => !client.connected)
    const release = run('unenroll')
    assert.equal((await once(release, 'exit'))[0], 0)
    await waitFor(() => connector.exitCode === 0)
    await call('GET', base + '/sessions', undefined, 404)
    assert.equal(service.exitCode, null)

    const abandoned = await call<{ id: string }>(
      'POST',
      '/targets',
      { kind: 'outbound', name: 'Interrupted setup' },
      201,
    )
    const enrollment = '/targets/' + abandoned.id + '/enrollment'
    const fresh = await call<{ code: string }>('POST', enrollment)
    dropEnrollmentReply = true
    assert.equal(await enroll(abandoned.id, fresh.code), 1)
    assert.equal((await call<{ enrolled: boolean }>('GET', enrollment)).enrolled, true)
    assert.equal((await once(run('unenroll'), 'close'))[0], 0)
    assert.equal((await call<{ enrolled: boolean }>('GET', enrollment)).enrolled, false)
  },
)

test(
  'MCP reports an interrupted or malformed machine reply without replaying a message or stopping the agent',
  { skip: !existsSync(program) || (process.platform !== 'linux' && !bun && !process.env.TEST_TERMINAL) },
  async t => {
    const home = await mkdtemp('/tmp/op-mcp-')
    t.after(() => rm(home, { recursive: true, force: true }))
    const directory = join(home, '.outpost')
    const socket = 'run/node-' + 'b'.repeat(32) + '.sock'
    const args = bun ? [resolve('machine/main.ts')] : []
    const env = { ...process.env, HOME: home }
    execFileSync(program, [...args, 'enroll', 'ssh', socket], { env })
    await mkdir(join(directory, 'run'), { recursive: true })
    const messages: string[] = []
    const node = createServer(connection => {
      connection.once('data', data => {
        messages.push(JSON.parse(data.toString()).arguments.message)
        connection.end(messages.length === 1 ? '' : 'invalid reply\n')
      })
    })
    node.listen(join(directory, socket))
    await once(node, 'listening')
    t.after(() => new Promise<void>(resolve => node.close(() => resolve())))
    const client = promisify(execFile)(program, [...args, 'mcp'], {
      timeout: 5000,
      env: { ...env, OUTPOST_SESSION_ID: randomUUID(), OUTPOST_DRIVER: 'terminal', OUTPOST_STATE_DIRECTORY: directory },
    })
    const requests = [
      { method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      ...['first', 'second'].map(message => ({
        method: 'tools/call',
        params: { name: 'message_session', arguments: { session: '@worker', message } },
      })),
      { method: 'ping' },
    ]
    client.child.stdin!.end(
      requests.map((request, id) => JSON.stringify({ jsonrpc: '2.0', id, ...request })).join('\n') + '\n',
    )
    const replies = (await client).stdout
      .trim()
      .split('\n')
      .map(line => JSON.parse(line).result)
    assert.equal(replies[1].isError, true)
    assert.match(replies[1].content[0].text, /connection closed/)
    assert.equal(replies[2].isError, true)
    assert.match(replies[2].content[0].text, /invalid reply/)
    assert.deepEqual(replies[3], {})
    assert.deepEqual(messages, ['first', 'second'])
  },
)
