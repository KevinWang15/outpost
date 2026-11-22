import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { createApp } from '../../backend/app'
import { LocalDeployment } from '../../backend/deployment'
import { fakeSoftware } from '../unit/fakes'
import { api } from './helpers'

const exec = promisify(execFile)
const image = process.env.OUTPOST_OPENRC_TEST_IMAGE
test(
  'the one-time installer starts OpenRC, reconnects after boot and removes its boot service on release',
  {
    skip: !image || process.platform !== 'linux',
    timeout: 120_000,
  },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'outpost-openrc-'))
    const name = 'outpost-terminal-linux-' + process.arch + '-musl'
    const path = resolve('machine/dist', name)
    await symlink(path, join(directory, name))
    const expected = createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
    await writeFile(join(directory, 'SHA256SUMS'), expected + '  ' + name + '\n')
    const deployment = await LocalDeployment.open(join(directory, 'server'))
    const app = await createApp({
      deployment,
      software: fakeSoftware,
      history: false,
      env: { ...process.env, OUTPOST_TERMINAL_ASSET_DIR: directory },
    })
    const origin = await app.listen({ host: '127.0.0.1', port: 0 })
    const call = api(origin)
    const container = (
      await exec('docker', ['run', '-d', '--init', '--stop-timeout', '1', '--network', 'host', image!])
    ).stdout.trim()
    t.after(async () => {
      await exec('docker', ['rm', '-f', container])
      await app.close()
      await rm(directory, { recursive: true, force: true })
    })
    const { id } = await call<{ id: string }>(
      'POST',
      '/targets',
      { kind: 'outbound', name: 'Boot', tools: ['codex'] },
      201,
    )
    const base = '/targets/' + id
    const { code } = await call<{ code: string }>('POST', base + '/enrollment')
    await exec(
      'docker',
      [
        'exec',
        '-e',
        'OUTPOST_ENROLLMENT',
        container,
        'sh',
        '-ec',
        'curl -fsS "$1/api/install/machine.sh" | sh -s -- "$1" "$2"',
        'sh',
        origin,
        id,
      ],
      { env: { ...process.env, OUTPOST_ENROLLMENT: code }, timeout: 60_000 },
    )
    const online = async () => {
      for (let i = 0; i < 150; i++) {
        if ((await fetch(origin + '/api' + base + '/sessions')).ok) return
        await delay(150)
      }
      const status = await exec('docker', [
        'exec',
        container,
        'sh',
        '-c',
        'rc-service outpost-machine status; rc-update show default',
      ])
      assert.fail('The supervised machine did not reconnect. ' + status.stdout)
    }
    await online()
    assert.match((await exec('docker', ['exec', container, 'rc-update', 'show', 'default'])).stdout, /outpost-machine/)
    await exec('docker', ['restart', container])
    await online()
    await exec('docker', ['exec', container, '/root/.outpost/bin/outpost-terminal', 'unenroll'])
    assert.equal((await call<{ enrolled: boolean }>('GET', base + '/enrollment')).enrolled, false)
    await exec('docker', ['exec', container, 'test', '!', '-e', '/etc/init.d/outpost-machine'])
  },
)
