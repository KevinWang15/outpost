import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import type { Session, SoftwareReport, Target } from '../../shared/model'
import type { TerminalTicket } from '../../shared/protocol'
import { createApp } from '../../backend/app'
import { LocalDeployment, type Deployment } from '../../backend/deployment'
import { HostedDeployment } from '../../backend/hosted/deployment'
import { terminalService } from '../../shared/terminalService'
import { exerciseMachineChat } from './machine-chat'
import { fixtures, TerminalClient } from './helpers'

const execute = promisify(execFile)
const acpFixture = join(fixtures, 'acp-agent-fixture.py')
const docker = await execute('docker', ['info'], { timeout: 20_000 }).then(
  () => true,
  () => false,
)
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16, 3)])

async function container(t: test.TestContext, options: string[]) {
  const id = (await execute('docker', ['run', '-d', '--rm', ...options, 'outpost-ssh-target'])).stdout.trim()
  t.after(() => execute('docker', ['rm', '-f', id]).catch(() => {}))
  const authorize = (key: string) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn('docker', [
        'exec',
        '-i',
        id,
        'sh',
        '-c',
        'cat >> /home/dev/.ssh/authorized_keys && chown dev:dev /home/dev/.ssh/authorized_keys && chmod 600 /home/dev/.ssh/authorized_keys',
      ])
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`authorize failed: ${code}`))))
      child.stdin.end(`${key.trim()}\n`)
    })
  return { id, authorize }
}

/** Exercise one deployment end to end against the SSH container. */
async function lifecycle(
  t: test.TestContext,
  deployment: Deployment,
  env: NodeJS.ProcessEnv,
  target: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const app = await createApp({ history: false, deployment, env, multiplex: true })
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
  const start = Date.now()
  while (true) {
    const { installation } = await call<{ installation: { status: string; error: string | null } }>(
      'GET',
      `/targets/${added.id}/installations`,
    )
    if (installation.status === 'succeeded') break
    if (installation.status === 'failed') {
      const log = await app.inject({
        url: `/api/targets/${added.id}/installations`,
        headers: { host: `127.0.0.1:${port}`, ...headers },
      })
      const { installation: job } = JSON.parse(log.body)
      const result = await app.inject({
        url: `/api/targets/${added.id}/installations/${job.id}/events`,
        headers: { host: `127.0.0.1:${port}`, ...headers },
      })
      assert.fail(job.error + '\n' + result.body)
    }
    assert.ok(Date.now() - start < 120000, 'Timed out waiting for SSH setup')
    await delay(200)
  }
  const report = await call<SoftwareReport>('GET', `/targets/${added.id}/software`)
  assert.deepEqual(
    report.software.filter(item => item.status !== 'installed'),
    [],
  )
  assert.equal(
    report.software.find(item => item.id === 'outpost-terminal')!.version,
    `outpost-terminal ${terminalService.version} protocol ${terminalService.protocol}`,
  )
  assert.equal(report.environment.home, '/home/dev')
  assert.equal(report.environment.username, 'dev')
  const session = await call<Session>('POST', `/targets/${added.id}/sessions`, {
    name: 'Over SSH',
    rootDir: '~/work',
    tool: 'claude',
    createDirectory: true,
  })
  const { token } = await call<TerminalTicket>('POST', `/targets/${added.id}/sessions/${session.id}/connect`, {})
  const fork = await call<Session>('POST', `/targets/${added.id}/sessions/${session.id}/fork`, {
    branch: `feature/fork-${session.id}`,
    rootDir: `~/work-${session.id}`,
  })
  assert.equal(fork.rootDir, `/home/dev/work-${session.id}`)
  assert.equal(fork.tool, session.tool)
  assert.notEqual(fork.conversations.at(-1)!.id, session.conversations.at(-1)!.id)
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
  const reference = await client.uploadImage(png)
  assert.match(reference, /^\/home\/dev\/\.outpost\/clipboard\/.+\.png$/)
  client.send({ type: 'paste', id: 'img', data: reference })
  const pasted = await client.take('result')
  assert.equal(pasted.ok, true, pasted.message ?? 'Request failed')
  const pid = /OUTPOST_FIXTURE_READY (\d+)/.exec(client.output)![1]
  // Abrupt transport loss (no WebSocket close handshake) must only detach the
  // viewer. Repeated attachments restore the same process and its screen.
  client.socket.terminate()
  await client.closed
  const again = new TerminalClient(`ws://127.0.0.1:${port}/api/terminal?token=${encodeURIComponent(hello.resume)}`)
  t.after(() => again.socket.terminate())
  await again.text(`OUTPOST_FIXTURE_READY ${pid}`)
  await again.message('ready')
  again.send({ type: 'ping', id: 'after-network-loss' })
  assert.deepEqual(await again.take('result'), { type: 'result', id: 'after-network-loss', ok: true })
  again.socket.close()
  await again.closed
  assert.equal((await call<Session>('POST', `/targets/${added.id}/sessions/${session.id}/terminate`)).status, 'stopped')
  await call('DELETE', `/targets/${added.id}/sessions/${session.id}`)
  const agent = await call<Session>('POST', `/targets/${added.id}/sessions`, {
    name: 'ACP',
    rootDir: '~/work',
    tool: 'claude',
  })
  await exerciseMachineChat(`http://127.0.0.1:${port}`, { targetId: added.id, sessionId: agent.id }, headers)
}

test(
  'SSH targets in local and hosted mode with the standalone terminal service',
  { timeout: 600_000, skip: !docker && 'Docker is unavailable' },
  async t => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'ops-')))
    t.after(() => rm(directory, { recursive: true, force: true }))

    await execute('docker', ['build', '-q', '-t', 'outpost-ssh-target', fixtures], { timeout: 600000 })
    const platform = process.arch + '-glibc'
    const serviceDir = join(directory, 'release')
    await mkdir(serviceDir)
    const file = 'outpost-terminal-linux-' + platform
    await copyFile(join(process.cwd(), 'machine/dist', file), join(serviceDir, file))
    const digest = async (path: string) =>
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
    await writeFile(join(serviceDir, 'SHA256SUMS'), (await digest(join(serviceDir, file))) + '  ' + file + '\n')
    const toolDir = join(directory, 'tools', platform)
    await mkdir(toolDir, { recursive: true })
    let manifest = ''
    for (const id of ['claude', 'claude-agent-acp']) {
      const stage = join(directory, id)
      await mkdir(stage)
      const dest = id === 'claude' ? '.local/bin' : '.outpost/bin'
      await copyFile(id === 'claude' ? join(fixtures, 'coding-tool-fixture.py') : acpFixture, join(stage, id))
      await writeFile(
        join(stage, 'install.sh'),
        `set -eu\nmkdir -p "$HOME/${dest}"\ninstall -m 700 ${id} "$HOME/${dest}/${id}"\n`,
      )
      const name = id + '.tar.gz'
      await execute('tar', ['-czf', join(toolDir, name), '-C', stage, '.'])
      manifest += (await digest(join(toolDir, name))) + '  ' + name + '\n'
    }
    await writeFile(join(toolDir, 'SHA256SUMS'), manifest)
    for (const mode of ['local', 'hosted'] as const)
      await t.test(mode + ' provisions an isolated target through an SSH bastion', async t => {
        const network = 'outpost-test-' + randomUUID()
        await execute('docker', ['network', 'create', '--internal', network])
        const jump = await container(t, ['-p', '127.0.0.1::22'])
        const target = await container(t, ['--network', network, '--network-alias', 'coding-host'])
        await execute('docker', ['network', 'connect', network, jump.id])
        t.after(() => execute('docker', ['network', 'rm', network]).catch(() => {}))
        await execute('docker', ['exec', target.id, 'rm', '/usr/local/bin/claude'])
        const port = Number((await execute('docker', ['port', jump.id, '22/tcp'])).stdout.trim().split(':').pop())
        const settings = {
          kind: 'ssh',
          name: 'Workstation',
          host: 'coding-host',
          user: 'dev',
          jump: { user: 'dev', host: '127.0.0.1', port },
          tools: ['claude'],
        }
        const env = {
          ...process.env,
          OUTPOST_TERMINAL_ASSET_DIR: serviceDir,
          OUTPOST_TOOL_ASSET_DIR: join(directory, 'tools'),
        }
        if (mode === 'local') {
          const key = join(directory, 'id')
          await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
          const pub = await readFile(key + '.pub', 'utf8')
          await jump.authorize(pub)
          await target.authorize(pub)
          const bin = join(directory, 'bin')
          await mkdir(bin)
          const config = join(directory, 'ssh_config')
          await writeFile(
            config,
            `Host *\n IdentityFile "${key}"\n IdentitiesOnly yes\n StrictHostKeyChecking accept-new\n UserKnownHostsFile "${directory}/known_hosts"\n`,
          )
          await writeFile(join(bin, 'ssh'), `#!/bin/sh\nexec /usr/bin/ssh -F '${config}' "$@"\n`, { mode: 0o700 })
          await lifecycle(
            t,
            await LocalDeployment.open(join(directory, mode)),
            { ...env, PATH: bin + ':' + process.env.PATH },
            settings,
          )
        } else {
          const deployment = await HostedDeployment.open({
            directory: join(directory, mode),
            publicUrl: 'http://127.0.0.1:5173',
            mailer: null,
          })
          const user = deployment.store.create('ada@example.com', 'Ada', 'fixture-hash')
          deployment.store.consumeToken(deployment.store.issueToken(user.id, 'verify', 60000), 'verify')
          const login = deployment.store.issueSession(deployment.store.profile(user.id)!)
          const pub = (await deployment.keys.publicKey(user.id)).publicKey
          await jump.authorize(pub)
          await target.authorize(pub)
          await lifecycle(t, deployment, env, settings, { cookie: `outpost_session=${login.token}` })
          const known = await readFile(join(directory, mode, 'users', user.id, 'known_hosts'), 'utf8')
          assert.match(known, /coding-host/)
          assert.match(known, /127\.0\.0\.1/)
        }
      })
  },
)
