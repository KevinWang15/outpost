import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import type { Session, SoftwareReport, Target } from '../../shared/model'
import type { ConnectResponse } from '../../shared/protocol'
import { createApp } from '../../backend/app'
import { LocalDeployment, type Deployment } from '../../backend/deployment'
import { HostedDeployment } from '../../backend/hosted/deployment'
import { terminalService } from '../../shared/terminalService'
import { fixtures, terminalBinary, TerminalClient } from './helpers'

const execute = promisify(execFile)
const docker = await execute('docker', ['info'], { timeout: 20_000 }).then(
  () => true,
  () => false,
)
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16, 3)])

async function container(t: test.TestContext) {
  await execute('docker', ['build', '-q', '-t', 'outpost-v2-ssh-target', fixtures], { timeout: 600_000 })
  const id = (
    await execute('docker', ['run', '-d', '--rm', '-p', '127.0.0.1::22', 'outpost-v2-ssh-target'])
  ).stdout.trim()
  t.after(() => execute('docker', ['rm', '-f', id]).catch(() => {}))
  await execute('docker', ['exec', id, 'mkdir', '-p', '/root/.outpost/bin'])
  await execute('docker', ['cp', terminalBinary, `${id}:/root/.outpost/bin/outpost-terminal`])
  const port = Number((await execute('docker', ['port', id, '22/tcp'])).stdout.trim().split(':').pop())
  const authorize = (key: string) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn('docker', [
        'exec',
        '-i',
        id,
        'sh',
        '-c',
        'cat >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys',
      ])
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`authorize failed: ${code}`))))
      child.stdin.end(`${key.trim()}\n`)
    })
  return { id, port, authorize }
}

/** Exercise one deployment end to end against the SSH container. */
async function lifecycle(
  t: test.TestContext,
  deployment: Deployment,
  env: NodeJS.ProcessEnv,
  target: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const app = await createApp({ deployment, env, multiplex: true })
  await app.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => app.close())
  const port = (app.server.address() as { port: number }).port
  const call = async <T>(method: string, url: string, payload?: unknown) => {
    const response = await app.inject({
      method: method as 'GET',
      url: `/api${url}`,
      payload: payload as object,
      headers: { host: `127.0.0.1:${port}`, 'x-outpost-request': '1', ...headers },
    })
    assert.ok(response.statusCode < 300, `${method} ${url}: ${response.body}`)
    return (response.body ? JSON.parse(response.body) : undefined) as T
  }
  const added = await call<Target>('POST', '/targets', target)
  const report = await call<SoftwareReport>('GET', `/targets/${added.id}/software`)
  assert.deepEqual(
    report.software.filter(item => item.status !== 'installed'),
    [],
  )
  assert.equal(
    report.software.find(item => item.id === 'outpost-terminal')!.version,
    `outpost-terminal ${terminalService.version} protocol ${terminalService.protocol}`,
  )
  assert.equal(report.environment.home, '/root')
  const session = await call<Session>('POST', `/targets/${added.id}/sessions`, {
    name: 'Over SSH',
    rootDir: '~/work',
    tool: 'claude',
    createDirectory: true,
  })
  const { token } = await call<ConnectResponse>('POST', `/targets/${added.id}/sessions/${session.id}/connect`, {
    terminal: 'web',
  })
  const fork = await call<Session>('POST', `/targets/${added.id}/sessions/${session.id}/fork`, {
    branch: `feature/fork-${session.id}`,
    rootDir: `~/work-${session.id}`,
  })
  assert.equal(fork.rootDir, `/root/work-${session.id}`)
  assert.equal(fork.tool, session.tool)
  assert.notEqual(fork.cliSessionId, session.cliSessionId)
  assert.equal(fork.status, 'ready')
  await call('DELETE', `/targets/${added.id}/sessions/${fork.id}`)
  const client = new TerminalClient(
    `ws://127.0.0.1:${port}/api/terminal?token=${encodeURIComponent(token)}&cols=90&rows=28`,
  )
  t.after(() => client.socket.terminate())
  const hello = await client.message('hello')
  await client.message('ready')
  await client.text(/OUTPOST_FIXTURE_READY \d+ 90x28/)
  client.send({ type: 'resize', cols: 70, rows: 20 })
  await client.text('70x20')
  const upload = await fetch(`http://127.0.0.1:${port}/api/terminal/image`, {
    method: 'POST',
    headers: { authorization: `Bearer ${hello.resume}`, 'x-outpost-request': '1', 'content-type': 'image/png' },
    body: png,
  })
  assert.equal(upload.status, 200)
  const image = (await upload.json()) as { reference: string }
  assert.match(image.reference, /^\/root\/\.outpost\/clipboard\/.+\.png$/)
  client.send({ type: 'paste', id: 'img', data: image.reference })
  const pasted = await client.take('result')
  assert.equal(pasted.ok, true, pasted.message)
  const pid = /OUTPOST_FIXTURE_READY (\d+)/.exec(client.output)![1]
  client.socket.close()
  const again = new TerminalClient(`ws://127.0.0.1:${port}/api/terminal?token=${encodeURIComponent(hello.resume)}`)
  t.after(() => again.socket.terminate())
  await again.text(`OUTPOST_FIXTURE_READY ${pid}`)
  again.socket.close()
  await again.closed
  assert.equal((await call<Session>('POST', `/targets/${added.id}/sessions/${session.id}/terminate`)).status, 'stopped')
  await call('DELETE', `/targets/${added.id}/sessions/${session.id}`)
}

test(
  'SSH targets in local and hosted mode with the standalone terminal service',
  { timeout: 600_000, skip: !docker && 'Docker is unavailable' },
  async t => {
    const target = await container(t)
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'outpost-ssh-')))
    t.after(() => rm(directory, { recursive: true, force: true }))

    await t.test('local mode uses your OpenSSH identity, with connection sharing', async t => {
      await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, 'id')])
      await target.authorize(await readFile(join(directory, 'id.pub'), 'utf8'))
      // Keep host keys out of the real ~/.ssh: OpenSSH ignores $HOME for known_hosts.
      const bin = join(directory, 'bin')
      await mkdir(bin)
      await writeFile(
        join(bin, 'ssh'),
        `#!/bin/sh\nexec /usr/bin/ssh -o UserKnownHostsFile=${join(directory, 'known_hosts')} "$@"\n`,
        { mode: 0o700 },
      )
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }
      await lifecycle(t, await LocalDeployment.open(join(directory, 'local')), env, {
        kind: 'ssh',
        name: 'Container',
        host: '127.0.0.1',
        port: target.port,
        identityFile: join(directory, 'id'),
        tools: ['claude'],
      })
    })

    await t.test('hosted mode uses only the account key', async t => {
      const deployment = await HostedDeployment.open({
        directory: join(directory, 'hosted'),
        publicUrl: 'http://127.0.0.1:5173',
        mailer: null,
      })
      const user = deployment.store.create(
        'ada@example.com',
        'Ada',
        'scrypt$131072$8$1$' + 'A'.repeat(22) + '$' + 'B'.repeat(86),
      )
      deployment.store.consumeToken(deployment.store.issueToken(user.id, 'verify', 60_000), 'verify')
      const login = deployment.store.issueSession(deployment.store.profile(user.id)!)
      await target.authorize((await deployment.keys.publicKey(user.id)).publicKey)
      await lifecycle(
        t,
        deployment,
        process.env,
        { kind: 'ssh', name: 'Container', host: '127.0.0.1', port: target.port, tools: ['claude'] },
        { cookie: `outpost_session=${login.token}` },
      )
      assert.match(await readFile(join(directory, 'hosted', 'users', user.id, 'known_hosts'), 'utf8'), /127\.0\.0\.1/)
    })
  },
)
