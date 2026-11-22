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
    let interrupt = true
    app.addHook('onSend', async (request, reply, payload) => {
      if (interrupt && request.url === '/api/machine/enroll' && reply.statusCode === 200) {
        interrupt = false
        reply.hijack()
        reply.raw.destroy()
      }
      return payload
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
    const installed = '/root/.outpost/bin/outpost-terminal'
    const inside = (...args: string[]) => exec('docker', ['exec', container, ...args], { timeout: 20_000 })
    const enroll = async () => {
      const { code } = await call<{ code: string }>('POST', base + '/enrollment')
      return exec(
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
    }
    const enrolled = async () => (await call<{ enrolled: boolean }>('GET', base + '/enrollment')).enrolled
    // A fresh install loses its first confirmed redemption. Its normal CLI must
    // be usable to abandon the pending claim and revoke the accepted credential.
    await assert.rejects(enroll(), /Could not confirm enrollment/)
    assert.equal(await enrolled(), true)
    assert.match((await inside(installed, 'status')).stdout, /Enrollment pending/)
    await inside(installed, 'unenroll')
    assert.equal(await enrolled(), false)
    await enroll()
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
    await inside(installed, 'unenroll')
    assert.equal(await enrolled(), false)
    await inside('test', '!', '-e', '/etc/init.d/outpost-machine')

    // Hold installation immediately before the init script appears, then
    // release the machine concurrently. Both operations must agree on its final state.
    await inside(
      'sh',
      '-ec',
      `real=$(command -v install)
cat > /usr/local/bin/install <<'SH'
#!/bin/sh
touch /tmp/outpost-install-started
while [ ! -f /tmp/outpost-install-continue ]; do sleep 0.05; done
SH
printf 'exec "%s" "$@"\\n' "$real" >> /usr/local/bin/install
chmod 755 /usr/local/bin/install`,
    )
    const installing = enroll()
    const waitFor = (file: string) => inside('sh', '-ec', 'while [ ! -f "$1" ]; do sleep 0.05; done', 'sh', file)
    await waitFor('/tmp/outpost-install-started')
    const releasing = inside('sh', '-ec', 'touch /tmp/outpost-release-started; exec "$1" unenroll', 'sh', installed)
    try {
      await waitFor('/tmp/outpost-release-started')
      assert.equal(await Promise.race([releasing.then(() => 'released'), delay(300, 'waiting')]), 'waiting')
    } finally {
      await inside('touch', '/tmp/outpost-install-continue')
      await Promise.all([installing, releasing])
    }
    assert.equal(await enrolled(), false)
    await inside('test', '!', '-e', '/etc/init.d/outpost-machine')
  },
)
