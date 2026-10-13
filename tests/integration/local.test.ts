import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import type { Session, SoftwareReport, Target } from '../../shared/model'
import type { ConnectResponse } from '../../shared/protocol'
import { createApp } from '../../backend/app'
import { LocalDeployment } from '../../backend/deployment'
import { api, fixtureHome, removeHome, TerminalClient } from './helpers'

const execute = promisify(execFile)
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64, 1)]).toString('base64')

test('local target: create, connect from a web client, paste, signal, reconnect, detach, terminate', { timeout: 120_000, skip: process.platform !== 'linux' }, async t => {
  const { directory, home, env } = await fixtureHome('outpost-local-')
  const deployment = await LocalDeployment.open(join(directory, 'data'))
  const app = await createApp({ deployment, env, multiplex: false })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as { port: number }).port
  const request = api(`http://127.0.0.1:${port}`)
  const clients: TerminalClient[] = []
  t.after(async () => {
    for (const client of clients) client.socket.terminate()
    await app.close()
    await removeHome(directory, home)
  })

  const target = await request<Target>('POST', '/targets', { kind: 'local', name: 'This computer', tools: ['claude', 'codex', 'kimi'] }, 201)
  const report = await request<SoftwareReport>('GET', `/targets/${target.id}/software`)
  assert.deepEqual(report.software.map(item => [item.id, item.status]), [['bash', 'installed'], ['python3', 'installed'], ['tmux', 'installed'], ['claude', 'installed'], ['codex', 'installed'], ['kimi', 'installed']])
  assert.equal(report.environment.home, home, 'never touches the real home')

  const project = join(home, 'project')
  const session = await request<Session>('POST', `/targets/${target.id}/sessions`, { name: 'Build', rootDir: '~/project', tool: 'claude', createDirectory: true }, 201)
  assert.equal(session.status, 'ready')
  await writeFile(join(project, 'capture-input'), '')

  const connect = async () => {
    const { token, url } = await request<ConnectResponse>('POST', `/targets/${target.id}/sessions/${session.id}/connect`, { terminal: 'web' })
    assert.equal(url, null)
    return token
  }
  const token = await connect()
  const client = new TerminalClient(`ws://127.0.0.1:${port}/api/terminal?token=${encodeURIComponent(token)}&cols=100&rows=30`)
  clients.push(client)
  const hello = await client.message('hello')
  assert.equal(hello.session.name, 'Build')
  assert.equal(hello.target.name, 'This computer')
  await client.message('ready')
  await client.text('OUTPOST_FIXTURE_READY')
  await client.text('100x30')

  await t.test('resize and typed input reach the coding tool', async () => {
    client.send({ type: 'resize', cols: 90, rows: 25 })
    await client.text('90x25')
    client.input('typed-by-client')
    await client.until(async () => (await readFile(join(project, 'input.bin'), 'utf8').catch(() => '')).includes('typed-by-client'), 'typed input')
    client.send({ type: 'send', id: 'draft-1', data: 'from-composer' })
    const result = await client.take('result')
    assert.deepEqual(result, { type: 'result', id: 'draft-1', ok: true })
  })

  await t.test('images are uploaded over the connection and pasted once', async () => {
    client.send({ type: 'paste-image', id: 'image-1', mediaType: 'image/png', data: png })
    const result = await client.take('result')
    assert.equal(result.ok, true, result.message)
    assert.match(result.reference!, new RegExp(`^${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.outpost/clipboard/${session.id}/.+\\.png$`))
    await client.until(async () => (await readFile(join(project, 'input.bin'), 'utf8').catch(() => '')).includes(result.reference!), 'pasted reference')
    client.send({ type: 'paste-image', id: 'image-2', mediaType: 'image/png', data: 'not-base64' })
    assert.equal((await client.take('result')).message, 'Invalid image data')
  })

  await t.test('browser links from the session reach the attached client', async () => {
    const helper = execute(join(home, '.outpost', 'bin', 'outpost-browser'), ['https://example.com/docs'], { env: { ...env, OUTPOST_SESSION_ID: session.id } })
    const signal = await client.take('signal')
    assert.deepEqual(signal.signal, { type: 'browser.open', payload: { url: 'https://example.com/docs' } })
    await helper
    await assert.rejects(execute(join(home, '.outpost', 'bin', 'outpost-browser'), ['file:///etc/passwd'], { env: { ...env, OUTPOST_SESSION_ID: session.id } }), /HTTP or HTTPS/)
  })

  await t.test('launch tokens are single use; resume tokens reconnect to the same process', async () => {
    const reused = new TerminalClient(`ws://127.0.0.1:${port}/api/terminal?token=${encodeURIComponent(token)}`)
    clients.push(reused)
    assert.equal((await reused.message('closed')).reason, 'expired')
    const pid = JSON.parse(await readFile(join(project, 'heartbeat.json'), 'utf8')).pid
    client.socket.close()
    await client.closed
    await client.until(async () => (await request<Session>('GET', `/targets/${target.id}/sessions/${session.id}`)).status === 'detached', 'detached status')
    const again = new TerminalClient(`ws://127.0.0.1:${port}/api/terminal?token=${encodeURIComponent(hello.resume)}&cols=80&rows=24`)
    clients.push(again)
    await again.message('ready')
    await again.text(`OUTPOST_FIXTURE_READY ${pid}`)
    again.input('\x1c')
    const closed = await again.message('closed')
    assert.equal(closed.reason, 'detached')
  })

  await t.test('terminating closes terminals and keeps the record', async () => {
    const live = new TerminalClient(`ws://127.0.0.1:${port}/api/terminal?token=${encodeURIComponent(await connect())}`)
    clients.push(live)
    await live.message('ready')
    const stopped = await request<Session>('POST', `/targets/${target.id}/sessions/${session.id}/terminate`)
    assert.equal(stopped.status, 'stopped')
    assert.equal((await live.message('closed')).reason, 'ended')
    await request('DELETE', `/targets/${target.id}/sessions/${session.id}`, undefined, 204)
  })
})

test('local sessions connect without a prior software check', { timeout: 60_000, skip: process.platform !== 'linux' }, async t => {
  const { directory, home, env } = await fixtureHome('outpost-local-')
  const app = await createApp({ deployment: await LocalDeployment.open(join(directory, 'data')), env, multiplex: false })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as { port: number }).port
  const request = api(`http://127.0.0.1:${port}`)
  const clients: TerminalClient[] = []
  t.after(async () => { for (const client of clients) client.socket.terminate(); await app.close(); await removeHome(directory, home) })
  const target = await request<Target>('POST', '/targets', { kind: 'local', name: 'Fresh', tools: ['codex'] }, 201)
  assert.equal(target.environment, undefined)
  const session = await request<Session>('POST', `/targets/${target.id}/sessions`, { name: 'First', rootDir: '~/first', tool: 'codex', createDirectory: true }, 201)
  const { token } = await request<ConnectResponse>('POST', `/targets/${target.id}/sessions/${session.id}/connect`, { terminal: 'web' })
  const client = new TerminalClient(`ws://127.0.0.1:${port}/api/terminal?token=${encodeURIComponent(token)}`)
  clients.push(client)
  await client.message('ready')
  await client.text('OUTPOST_FIXTURE_READY')
})
