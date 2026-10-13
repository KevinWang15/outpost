import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import test from 'node:test'
import type { Session, Target } from '../../shared/model'
import type { ConnectResponse } from '../../shared/protocol'
import { createApp } from '../../backend/app'
import { LocalDeployment } from '../../backend/deployment'
import { api, fixtureHome, fixtures, removeHome } from './helpers'

const execute = promisify(execFile)
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 7)])

test(
  'native connector in a PTY: attach, keys, image and text paste, OSC 52 copy, links, detach and reconnect',
  { timeout: 120_000, skip: process.platform !== 'linux' },
  async t => {
    const { directory, home, env } = await fixtureHome('outpost-connector-')
    const start = async (port = 0) => {
      const instance = await createApp({
        deployment: await LocalDeployment.open(join(directory, 'data')),
        env,
        multiplex: false,
      })
      await instance.listen({ host: '127.0.0.1', port })
      return instance
    }
    let app = await start()
    const port = (app.server.address() as { port: number }).port
    const server = `http://127.0.0.1:${port}`
    const request = api(server)
    t.after(async () => {
      await app.close()
      await removeHome(directory, home)
    })

    const target = await request<Target>('POST', '/targets', { kind: 'local', name: 'Laptop', tools: ['claude'] }, 201)
    await request('GET', `/targets/${target.id}/software`)
    const session = await request<Session>(
      'POST',
      `/targets/${target.id}/sessions`,
      { name: 'Build', rootDir: '~/project', tool: 'claude', createDirectory: true },
      201,
    )
    const project = join(home, 'project')
    await writeFile(join(project, 'capture-input'), '')
    const { url } = await request<ConnectResponse>('POST', `/targets/${target.id}/sessions/${session.id}/connect`, {
      terminal: 'iterm2',
    })
    assert.match(url!, /^outpost:\/\/connect\/[A-Za-z0-9_-]+$/)

    // Install the connector exactly as served, trusting only this server.
    const connector = join(directory, 'connector'),
      fake = join(directory, 'fake')
    await mkdir(connector)
    await mkdir(fake)
    const archive = join(connector, 'outpost-connector.pyz')
    await writeFile(
      archive,
      Buffer.from(await (await fetch(`${server}/connector/outpost-connector.pyz`)).arrayBuffer()),
    )
    await writeFile(join(connector, 'config.json'), JSON.stringify({ servers: [server] }))
    const install = await (await fetch(`${server}/connector/install.sh`)).text()
    assert.match(install, new RegExp(`server='${server}'`))

    const driver = spawn(
      'python3',
      [join(fixtures, 'pty_driver.py'), '100', '30', '--', 'python3', archive, 'attach', url!],
      {
        env: { ...env, OUTPOST_CONNECTOR_HOME: connector, OUTPOST_CONNECTOR_FAKE: fake },
      },
    )
    t.after(() => {
      if (driver.exitCode === null) driver.kill()
    })
    let output = '',
      exitCode: number | null = null
    createInterface({ input: driver.stdout }).on('line', line => {
      const message = JSON.parse(line)
      if (message.output) output += Buffer.from(message.output, 'base64').toString('utf8')
      if ('exit' in message) exitCode = message.exit
    })
    const control = (message: unknown) => driver.stdin.write(`${JSON.stringify(message)}\n`)
    const type = (data: string) => control({ write: Buffer.from(data).toString('base64') })
    const until = async (check: () => unknown, label: string) => {
      for (
        const deadline = Date.now() + 15_000;
        Date.now() < deadline;
        await new Promise(resolve => setTimeout(resolve, 25))
      )
        if (await check()) return
      throw new Error(`Timed out waiting for ${label}. Output: ${JSON.stringify(output.slice(-1500))}`)
    }
    const input = () => readFile(join(project, 'input.bin'), 'latin1').catch(() => '')

    await until(() => /OUTPOST_FIXTURE_READY \d+ 100x30/.test(output), 'attached at the terminal size')
    const pid = /OUTPOST_FIXTURE_READY (\d+)/.exec(output)![1]

    await t.test('typing and resizing behave like a local program', async () => {
      type('typed-in-iterm')
      await until(async () => (await input()).includes('typed-in-iterm'), 'typed input')
      control({ resize: [90, 25] })
      await until(() => output.includes('90x25'), 'resize')
    })

    await t.test('Ctrl+V pastes an image when the clipboard has one, and passes through otherwise', async () => {
      type('\x16')
      await until(async () => (await input()).includes('\x16'), 'plain Ctrl+V')
      await writeFile(join(fake, 'clipboard.png'), png)
      type('\x16after')
      await until(async () => /\.outpost\/clipboard\/[^\s]+\.png/.test(await input()), 'image reference')
      const recorded = await input()
      assert.equal(recorded.split('\x16').length, 2, 'the gesture is not forwarded when it pastes an image')
      assert.ok(recorded.indexOf('.png') < recorded.indexOf('after'), 'keystrokes after the gesture keep their order')
      const start = recorded.indexOf(join(home, '.outpost', 'clipboard'))
      assert.deepEqual(await readFile(recorded.slice(start, recorded.indexOf('.png', start) + 4)), png)
    })

    await t.test('the Outpost paste key pastes clipboard text as one bracketed paste', async () => {
      await unlink(join(fake, 'clipboard.png'))
      await writeFile(join(fake, 'clipboard.txt'), 'line one\nline two')
      type('\x1b[9001~')
      await until(async () => (await input()).includes('\x1b[200~line one\rline two\x1b[201~'), 'bracketed text paste')
    })

    await t.test('remote copies reach the local clipboard; links open locally', async () => {
      type('clipboard')
      await until(
        async () =>
          (await readFile(join(fake, 'copied.txt'), 'utf8').catch(() => '')).includes('OUTPOST_CLIPBOARD_TEST'),
        'OSC 52 copy',
      )
      assert.ok(!output.includes('\x1b]52;'), 'OSC 52 is consumed, not shown to the terminal app')
      await execute(join(home, '.outpost', 'bin', 'outpost-browser'), ['https://example.com/pr/1'], {
        env: { ...env, OUTPOST_SESSION_ID: session.id },
      })
      await until(
        async () =>
          (await readFile(join(fake, 'opened.txt'), 'utf8').catch(() => '')).includes('https://example.com/pr/1'),
        'opened link',
      )
    })

    await t.test('a dropped connection reconnects by itself to the same process', async () => {
      output = ''
      await app.close()
      await until(() => output.includes('Connection lost'), 'reconnect banner')
      app = await start(port)
      await until(() => output.includes(`OUTPOST_FIXTURE_READY ${pid}`), 'automatic reconnect')
    })

    await t.test('detach shows a banner; Enter reattaches to the same process; Ctrl+C closes', async () => {
      output = ''
      type('\x1c')
      await until(() => output.includes('Detached from Build · Laptop'), 'detached banner')
      output = ''
      type('\r')
      await until(() => output.includes(`OUTPOST_FIXTURE_READY ${pid}`), 'same process after reconnect')
      type('\x1c')
      await until(() => output.includes('Enter  reconnect'), 'second banner')
      type('\x03')
      await until(() => exitCode !== null, 'connector exit')
      assert.equal(exitCode, 0)
    })
  },
)
