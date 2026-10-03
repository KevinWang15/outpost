import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { createApp } from '../backend/app.ts'
import { DesktopLauncher, desktopHost } from '../backend/desktop.ts'
import { TargetStore } from '../backend/store.ts'
import { quote } from '../backend/shell.ts'
import { terminalApps } from '../shared/terminals.ts'

for (const mode of ['automatic', 'selected', 'favorite']) test(`desktop API (${mode}) opens a real terminal with a controlling terminal and survives manager shutdown`, { timeout: 20_000 }, async t => {
  assert.ok(['linux', 'darwin'].includes(process.platform))
  if (process.platform === 'linux') assert.ok(process.env.DISPLAY, 'Run this test under xvfb-run or in a desktop session')
  else if (!await desktopHost().ownsConsole()) return t.skip('No logged-in macOS desktop belongs to this process')
  const directory = await mkdtemp(join(tmpdir(), 'outpost-gui-'))
  const bin = join(directory, "bin with 'quotes & é")
  const launchRoot = join(directory, "launch O’Brien $(literal)")
  await mkdir(bin)
  await mkdir(launchRoot)
  const capture = join(directory, 'capture.json')
  const release = join(directory, 'release')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, OUTPOST_GUI_CAPTURE: capture, OUTPOST_GUI_RELEASE: release }
  await writeFile(join(bin, 'ssh'), `#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
capture = Path(os.environ['OUTPOST_GUI_CAPTURE'])
capture.with_suffix('.tmp').write_text(json.dumps({'pid': os.getpid(), 'args': sys.argv[1:], 'tty': [os.isatty(fd) for fd in [0,1,2]], 'controlling': os.ttyname(os.open('/dev/tty', os.O_RDONLY))}))
capture.with_suffix('.tmp').replace(capture)
while not Path(os.environ['OUTPOST_GUI_RELEASE']).exists(): time.sleep(0.05)
`, { mode: 0o700 })
  const host = desktopHost(env)
  if (process.platform === 'linux') {
    const locate = host.executable
    host.executable = async name => ['bash', 'xterm'].includes(name) ? locate(name) : null
  } else {
    const locate = host.application
    host.application = async name => name === 'Terminal' ? locate(name) : null
    // Launch Services does not inherit the test process's environment. Inject only
    // the fixture's SSH PATH and output files into the generated local script.
    const start = host.start
    host.start = async (executable, args) => {
      const file = args.at(-1)
      const contents = await readFile(file, 'utf8')
      await writeFile(file, `#!/usr/bin/env bash\nexport PATH=${quote(env.PATH)}\nexport OUTPOST_GUI_CAPTURE=${quote(capture)}\nexport OUTPOST_GUI_RELEASE=${quote(release)}\n${contents}`)
      await start(executable, args)
    }
  }
  const store = new TargetStore(join(directory, 'manager'))
  const app = await createApp({ store, desktop: new DesktopLauncher(host, launchRoot), service: { get: async () => ({ id: 'session' }) } })
  let pid
  t.after(async () => {
    await app.close()
    await writeFile(release, '')
    await delay(150)
    if (pid) { try { process.kill(pid, 'SIGTERM') } catch { /* Already exited. */ } }
    await rm(directory, { recursive: true, force: true })
  })
  const target = { id: 'target', name: 'Desktop', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev-alias', backends: ['tmux'], identityFile: "~/key with 'quotes", createdAt: new Date().toISOString() }
  await store.add(target)
  const headers = { 'x-outpost-request': '1' }
  const connection = await app.inject({ method: 'POST', url: '/api/targets/target/sessions/session/connect', headers })
  const terminal = terminalApps.find(app => app.id === (process.platform === 'darwin' ? 'macos-terminal' : 'linux-xterm'))
  assert.deepEqual(connection.json().desktop, { os: terminal.os, terminals: [terminal], recommendedId: terminal.id })
  const payload = mode === 'selected' ? { terminalId: terminal.id } : mode === 'favorite' ? { preferences: { [terminal.os]: terminal.id } } : {}
  const launched = await app.inject({ method: 'POST', url: '/api/targets/target/sessions/session/launch', headers, payload })
  assert.equal(launched.statusCode, 200, launched.body)
  assert.deepEqual(launched.json(), terminal)
  let data
  const deadline = Date.now() + 5000
  while (!data && Date.now() < deadline) {
    try { data = JSON.parse(await readFile(capture, 'utf8')) } catch { await delay(50) }
  }
  assert.ok(data, 'the terminal executed the SSH connection script')
  pid = data.pid
  assert.deepEqual(data.tty, [true, true, true])
  assert.match(data.controlling, /^\/dev\//)
  assert.ok(data.args.includes('-tt'))
  assert.ok(data.args.includes('dev-alias'))
  assert.match(data.args.at(-1), /^bash -lic /)
  assert.deepEqual(await readdir(launchRoot), [], 'private launch scripts delete themselves before attaching')
  await app.close()
  assert.doesNotThrow(() => process.kill(pid, 0), 'closing the manager leaves the terminal and SSH process running')
})
