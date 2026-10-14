import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { connectorArchive, installScript } from '../../backend/connector'

test('installer removes all trusted deployments, including partial installations, and reports cleanup failures', t => {
  const directory = mkdtempSync(join(tmpdir(), 'outpost-uninstall-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const home = join(directory, 'home with spaces'),
    bin = join(directory, 'bin'),
    downloads = join(directory, 'downloads'),
    connector = join(home, '.outpost-connector'),
    archive = join(directory, 'served.pyz'),
    requests = join(directory, 'requests'),
    actions = join(directory, 'actions')
  for (const path of [home, bin, downloads]) mkdirSync(path)
  writeFileSync(archive, connectorArchive)
  // Run the actual served script and zipapp. Only HTTP downloads and Windows
  // processes are replaced; real Windows registry cleanup runs in Windows CI.
  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env python3
import os, shutil, sys
with open(os.environ['REQUESTS'], 'a') as stream:
    stream.write(sys.argv[2] + '\\n')
shutil.copyfile(os.environ['ARCHIVE_FIXTURE'], sys.argv[sys.argv.index('-o') + 1])
`,
    { mode: 0o755 },
  )
  writeFileSync(
    join(bin, 'powershell.exe'),
    `#!/usr/bin/env python3
import base64, json, os, sys
script = base64.b64decode(sys.argv[-1]).decode('utf-16-le')
settings = json.loads(base64.b64decode(script.split("FromBase64String('")[1].split("'")[0]))
with open(os.environ['ACTIONS'], 'a') as stream:
    stream.write(settings['action'] + '\\n')
if os.environ.get('FAIL_CLEANUP') == '1':
    sys.stderr.write('Registry access denied')
    sys.exit(1)
`,
    { mode: 0o755 },
  )
  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: downloads,
    PATH: `${bin}:${process.env.PATH}`,
    OUTPOST_CONNECTOR_HOME: connector,
    OUTPOST_CONNECTOR_FAKE: '',
    WSL_DISTRO_NAME: 'Ubuntu',
    ARCHIVE_FIXTURE: archive,
    REQUESTS: requests,
    ACTIONS: actions,
  }
  const run = (origin: string, args: string[] = [], overrides = {}) =>
    spawnSync('bash', ['-s', '--', ...args], {
      input: installScript(origin),
      env: { ...env, ...overrides },
      encoding: 'utf8',
      timeout: 20_000,
    })
  const first = 'https://outpost.example.com',
    second = 'http://localhost:3000'
  for (const args of [['--typo'], ['--uninstall', 'extra']]) {
    const result = run(first, args)
    assert.equal(result.status, 2, result.stderr)
    assert.match(result.stderr, /Usage:/)
  }
  assert.equal(run(first, ['--help']).status, 0)
  assert.ok(!existsSync(requests), 'help and invalid flags must not download or modify anything')
  assert.ok(!existsSync(connector))
  mkdirSync(connector, { mode: 0o755 })
  for (const server of [first, second]) {
    const result = run(server)
    assert.equal(result.status, 0, result.stderr)
  }
  assert.equal(statSync(connector).mode & 0o777, 0o700)
  assert.deepEqual(JSON.parse(readFileSync(join(connector, 'config.json'), 'utf8')).servers, [first, second])
  const serverState = join(home, '.outpost')
  mkdirSync(serverState)
  writeFileSync(join(serverState, 'keep'), 'server state')
  // Even a missing/corrupt installed archive must not prevent clean removal.
  rmSync(join(connector, 'outpost-connector.pyz'))
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = run(first, ['--uninstall'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /all trusted servers were removed/)
    assert.ok(!existsSync(connector), 'all trust, executables and partial downloads are gone')
    assert.deepEqual(readdirSync(downloads), [], 'the downloaded uninstaller is cleaned up too')
  }
  assert.equal(readFileSync(join(serverState, 'keep'), 'utf8'), 'server state')
  assert.deepEqual(readFileSync(actions, 'utf8').trim().split('\n'), [
    'install',
    'install-profile',
    'install',
    'install-profile',
    'uninstall-profile',
    'uninstall',
    'uninstall-profile',
    'uninstall',
  ])
  mkdirSync(connector)
  writeFileSync(join(connector, 'config.json'), JSON.stringify({ servers: [first, second] }))
  const failed = run(first, ['--uninstall'], { FAIL_CLEANUP: '1' })
  assert.equal(failed.status, 1, failed.stderr)
  assert.match(failed.stderr, /Uninstall was incomplete:.*Registry access denied/)
  assert.ok(!existsSync(connector), 'trust is revoked even if OS cleanup fails')
  assert.deepEqual(readdirSync(downloads), [])

  if (process.platform === 'linux') {
    // Reproduce a genuinely unwritable temporary directory, including when
    // this test suite itself is run as root (drop the child to nobody).
    const uid = process.getuid!() === 0 ? 65534 : process.getuid!(),
      gid = process.getuid!() === 0 ? 65534 : process.getgid!(),
      userHome = join(directory, 'unprivileged home'),
      blocked = join(directory, 'unwritable tmp')
    chmodSync(directory, 0o755)
    chmodSync(bin, 0o755)
    for (const executable of ['curl', 'powershell.exe']) chmodSync(join(bin, executable), 0o755)
    chmodSync(archive, 0o644)
    mkdirSync(userHome, { mode: 0o700 })
    if (process.getuid!() === 0) chownSync(userHome, uid, gid)
    mkdirSync(blocked, { mode: 0o500 })
    const userConnector = join(userHome, '.outpost-connector')
    for (const args of [[], ['--uninstall']]) {
      const result = spawnSync('bash', ['-s', '--', ...args], {
        input: installScript(first),
        env: {
          ...env,
          HOME: userHome,
          TMPDIR: blocked,
          OUTPOST_CONNECTOR_HOME: userConnector,
          REQUESTS: join(userHome, 'requests'),
          ACTIONS: join(userHome, 'actions'),
        },
        uid,
        gid,
        encoding: 'utf8',
        timeout: 20_000,
      })
      assert.equal(result.status, 0, result.stderr)
      assert.ok(!readdirSync(userHome).some(name => name.startsWith('.outpost-connector-tmp.')))
      if (args.length === 0) assert.ok(existsSync(join(userConnector, 'config.json')))
      else {
        assert.ok(result.stdout.includes(userConnector), 'uninstall identifies the data directory it removed')
        assert.ok(!existsSync(userConnector))
      }
    }
    assert.deepEqual(readdirSync(blocked), [])
  }
})
