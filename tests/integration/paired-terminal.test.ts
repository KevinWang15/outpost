// Production client, broker, outbound node and a real PTY. Run on Linux with
// the built target binary, or set TEST_BUN to a Bun executable for source mode.
import { serverRequest } from '../../desktop/src/server-api'
import { parseDesktopLoginCallback } from '../../shared/desktopAuth'
import { directResponse } from '../../shared/directOnly'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket as Peer, WebSocketServer } from 'ws'
import { createApp } from '../../backend/app'
import { LocalDeployment } from '../../backend/deployment'
import { TerminalSocket } from '../../frontend/terminal/socket'
import type { TerminalState } from '../../frontend/terminal/connection'
import { publish } from '../../machine/files'
import { state } from '../../machine/state'
import { record, register } from '../machine/fixtures'
import { terminalBinary } from './helpers'

const bun = process.platform === 'linux' ? undefined : process.env.TEST_BUN
const executable = process.platform === 'linux' ? terminalBinary : (process.env.TEST_TERMINAL ?? terminalBinary)
async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await delay(50)
  }
  assert.fail('Timed out waiting for terminal state')
}

for (const directOnly of [false, true])
  test(
    directOnly
      ? 'direct-only enrollment, discovery, terminal, transfers and local revocation without machine egress'
      : 'relay-enabled machine chooses direct, resumes through relay and revokes both paths',
    {
      skip: !bun && !(existsSync(executable) && (process.env.TEST_TERMINAL || process.platform === 'linux')),
      timeout: directOnly ? 75000 : 45000,
    },
    async () => {
      const home = await mkdtemp('/tmp/op-pair-')
      const previous = state.directory
      state.directory = join(home, '.outpost')
      const cleanup: (() => Promise<void> | void)[] = [
        async () => {
          state.directory = previous
          await rm(home, { recursive: true, force: true })
        },
      ]
      try {
        await mkdir(join(state.directory, 'terminals'), { recursive: true })
        const session = record(home, 'codex', randomUUID())
        await register(session)
        const portServer = createServer()
        portServer.listen(0, '127.0.0.1')
        await once(portServer, 'listening')
        const port = (portServer.address() as AddressInfo).port
        await new Promise<void>(ok => portServer.close(() => ok()))
        const env = {
          ...process.env,
          HOME: home,
          OUTPOST_DIRECT_ORIGIN: 'http://127.0.0.1:' + port,
          OUTPOST_DIRECT_PORT: String(port),
        }
        const run = (...args: string[]) => {
          // The direct-only machine may accept IP connections and use its private Unix sockets.
          const sandbox = directOnly && process.platform === 'darwin'
          const cmd = [bun ?? executable, ...(bun ? [resolve('machine/main.ts')] : []), ...args]
          const child = spawn(
            sandbox ? '/usr/bin/sandbox-exec' : cmd[0],
            sandbox
              ? ['-p', '(version 1)(allow default)(deny network-outbound (remote ip "*:*"))', ...cmd]
              : cmd.slice(1),
            {
              env,
              stdio: ['pipe', 'ignore', 'inherit'],
            },
          )
          const exit = once(child, 'exit')
          cleanup.push(async () => {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill()
              await exit
            }
          })
          return child
        }
        const uninstalledNode = run('node', '--socket', 'run/node-' + '0'.repeat(32) + '.sock')
        assert.notEqual((await once(uninstalledNode, 'exit'))[0], 0)
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
          history: false,
          multiplex: false,
        })
        const origin = await app.listen({ host: '127.0.0.1', port: 0 })
        cleanup.push(() => app.close())
        const request = (path: string, body: object = {}, method = 'POST') =>
          fetch(origin + '/api' + path, {
            method,
            headers: { 'Content-Type': 'application/json', 'x-outpost-request': '1' },
            body: JSON.stringify(body),
          })
        let enroll = 0,
          registrations = 0
        app.server.on('request', req => {
          if (req.url === '/api/paired/enroll') enroll++
        })
        app.server.on('upgrade', req => {
          if (req.url === '/api/paired/node') registrations++
        })
        const target = await (
          await request('/targets', {
            ...(directOnly ? { kind: 'direct', endpoint: env.OUTPOST_DIRECT_ORIGIN } : { kind: 'paired' }),
            name: 'Test',
            tools: ['codex'],
          })
        ).json()
        const targetPath = '/targets/' + target.id
        let installJson = ''
        if (directOnly) {
          installJson = JSON.stringify(await (await request(targetPath + '/direct-install')).json())
          const pair = run('pair', '--direct')
          pair.stdin.end(installJson + '\n')
          assert.equal((await once(pair, 'exit'))[0], 0)
          const duplicate = run('pair', '--direct')
          duplicate.stdin.end(installJson + '\n')
          assert.notEqual((await once(duplicate, 'exit'))[0], 0)
          const ssh = run('node', '--socket', 'run/node-' + '1'.repeat(32) + '.sock')
          assert.notEqual((await once(ssh, 'exit'))[0], 0)
        } else {
          const { code } = await (await request(targetPath + '/pair')).json()
          assert.equal((await request('/paired/enroll', { code: randomUUID() })).status, 401)
          const pair = run('pair', origin)
          pair.stdin.end(code + '\n')
          assert.equal((await once(pair, 'exit'))[0], 0)
          assert.equal((await request('/paired/enroll', { code })).status, 401)
        }
        const connector = run('connect')
        if (directOnly) {
          const central = await fetch(origin + '/api' + targetPath + '/sessions')
          const copy = central.clone()
          await waitFor(async () => {
            try {
              await fetch(env.OUTPOST_DIRECT_ORIGIN + '/health')
              return true
            } catch {
              return false
            }
          })
          const res = await directResponse(central)
          assert.equal(res.status, 200)
          assert.equal((await res.json()).sessions[0].id, session.id)
          assert.equal((await directResponse(copy)).status, 403, 'grants are single use')
        }
        if (directOnly) {
          const verifier = randomBytes(32).toString('base64url')
          const start = await (
            await request('/desktop/authorizations', {
              state: randomBytes(32).toString('base64url'),
              challenge: createHash('sha256').update(verifier).digest('base64url'),
            })
          ).json()
          const approval = await (
            await request('/desktop/authorizations/' + start.requestId, { allow: true, accountId: 'local' })
          ).json()
          const { code } = parseDesktopLoginCallback(approval.callback)
          const { token } = await (await request('/desktop/token', { code, verifier })).json()
          const list = await serverRequest(origin, targetPath + '/sessions', { token })
          assert.ok(Array.isArray(list) && list.some(item => item.sessionId === session.id))
        }
        let token = ''
        await waitFor(async () => {
          const response = await request(targetPath + '/sessions/' + session.id + '/connect')
          if (response.ok) token = (await response.json()).token
          return !!token
        })
        const image = resolve('public/outpost-256.png')
        const bytes = await readFile(image)
        const file = await publish(session.id, image)
        const connections: TerminalState[] = []
        let refuseDirect = false
        const impostor = new WebSocketServer({ host: '127.0.0.1', port: 0 })
        await once(impostor, 'listening')
        const otherOrigin = 'ws://127.0.0.1:' + (impostor.address() as AddressInfo).port
        const probes: string[] = []
        impostor.on('connection', peer => {
          peer.on('message', message => {
            probes.push(message.toString())
            peer.send(JSON.stringify({ proof: 'invalid' }))
          })
        })
        cleanup.push(() => new Promise<void>(ok => impostor.close(() => ok())))
        const servers: Peer[] = []
        const peers: Peer[] = []
        const centralFrames: string[] = []
        const output: Buffer[] = []
        const client = new TerminalSocket(
          token,
          () => ({ cols: 80, rows: 24 }),
          {
            begin() {},
            restore(_p, done) {
              done()
            },
            output(b, done) {
              output.push(Buffer.from(b))
              done()
            },
            flush(done) {
              done()
            },
          },
          { state: s => connections.push(s), activity() {}, signal() {}, hello() {}, deliveries() {} },
          {
            origin,
            open: url => {
              const direct = ['/api/terminal/direct', '/api/direct/terminal'].includes(url.pathname)
              if (direct) assert.equal(url.search, '')
              const ws = new Peer(direct && refuseDirect ? new URL(url.pathname, otherOrigin) : url, {
                origin,
              })
              if (direct) peers.push(ws)
              else {
                servers.push(ws)
                ws.on('message', (data, binary) =>
                  centralFrames.push(binary ? 'bytes' : JSON.parse(data.toString()).type),
                )
              }
              return ws as unknown as WebSocket
            },
          },
        )
        cleanup.push(() => client.close())
        client.open()
        const route = (name: string) =>
          connections.at(-1)?.kind === 'connected' && (connections.at(-1) as { route?: string }).route === name
        await waitFor(() => route('direct'))
        if (!directOnly) {
          const foreign = new Peer(env.OUTPOST_DIRECT_ORIGIN.replace(/^http/, 'ws') + '/api/terminal/direct', {
            origin: 'https://foreign.invalid',
          })
          const rejected = await new Promise<boolean>(resolve => {
            foreign.once('error', () => resolve(true))
            foreign.once('open', () => {
              foreign.close()
              resolve(false)
            })
          })
          assert.ok(rejected, 'relay-enabled machine rejects untrusted browser origins')
        }
        const transfer = async () => {
          const listed = await client.listFiles(AbortSignal.timeout(5000))
          assert.equal(listed[0].id, file.id)
          assert.deepEqual(
            Buffer.from(await (await client.readFile(listed[0], AbortSignal.timeout(5000))).arrayBuffer()),
            bytes,
          )
          const ref = await client.pasteImage(new File([bytes], 'image.png', { type: 'image/png' }))
          assert.deepEqual(await readFile(ref), bytes)
        }
        assert.equal(client.input('direct-route\n'), true)
        await waitFor(() => Buffer.concat(output).includes('direct-route'))
        await transfer()
        if (directOnly) {
          assert.ok(centralFrames.includes('direct-only'))
          assert.ok(centralFrames.every(kind => kind === 'direct-only' || kind === 'direct-lease'))
          assert.equal(enroll, 0)
          assert.equal(registrations, 0)
          // Withhold renewals on a second attachment. The machine must expire it autonomously.
          const next = await (await request(targetPath + '/sessions/' + session.id + '/connect')).json()
          const leaseUrl = new URL(servers[0].url)
          leaseUrl.searchParams.set('token', next.token)
          const control = new Peer(leaseUrl, { origin })
          const [offered] = await once(control, 'message')
          const offer = JSON.parse(offered.toString())
          assert.equal(offer.type, 'direct-only')
          const idle = new Peer(new URL('/api/direct/terminal', offer.origin.replace('http:', 'ws:')), { origin })
          cleanup.push(() => {
            idle.terminate()
            control.terminate()
          })
          await once(idle, 'open')
          const expires = once(idle, 'close')
          idle.send(offer.ticket)
          const [hello] = await once(idle, 'message')
          assert.equal(JSON.parse(hello.toString()).type, 'hello')
          control.close()
          await expires
          assert.equal(servers.length, 1, 'regular client kept its lease')
          assert.equal(enroll, 0)
          assert.equal(registrations, 0)
          await transfer()
          const unpair = run('unpair')
          assert.equal((await once(unpair, 'exit'))[0], 0)
          await waitFor(() => connector.exitCode !== null && !client.connected)
          const disabled = run('connect')
          assert.notEqual((await once(disabled, 'exit'))[0], 0)
          assert.equal(service.exitCode, null)
          const reinstall = run('pair', '--direct')
          reinstall.stdin.end(installJson + '\n')
          assert.equal((await once(reinstall, 'exit'))[0], 0)
          return
        }
        assert.deepEqual([...new Set(centralFrames)].sort(), ['hello', 'route-offer', 'route-selected'])
        refuseDirect = true
        peers[0].terminate()
        await waitFor(() => route('relay'))
        assert.equal(service.exitCode, null)
        assert.equal(servers.length, 2)
        await transfer()
        await client.removeFile(file.id, AbortSignal.timeout(5000))
        assert.deepEqual(await client.listFiles(AbortSignal.timeout(5000)), [])
        assert.ok(centralFrames.includes('result'))
        // A fresh attempt probes, rejects an endpoint with the wrong identity and still attaches.
        servers.at(-1)!.terminate()
        await waitFor(() => servers.length === 3 && route('relay'))
        assert.equal(probes.length, 1)
        assert.match(probes[0], /^[A-Za-z0-9_-]{32}$/)
        refuseDirect = false
        servers.at(-1)!.terminate()
        await waitFor(() => route('direct'))
        const authenticatedPeer = peers.at(-1)!
        assert.equal((await request(targetPath, {}, 'DELETE')).status, 204)
        await waitFor(() => authenticatedPeer.readyState === Peer.CLOSED)
        await waitFor(() => !client.connected)
      } finally {
        for (const action of cleanup.reverse()) await action()
      }
    },
  )
