import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { SoftwareClient } from '../backend/software.ts'
import { requiredSoftware } from '../shared/session-manager.ts'
import { installationScript } from '../backend/software-scripts.ts'
import { quote } from '../backend/shell.ts'

const execute = promisify(execFile)
const target = { kind: 'local', id: 'test', name: 'test', backends: ['dtach'], tools: ['codex', 'kimi', 'claude'], createdAt: '2026-09-30T00:00:00Z' }

test('requirements follow selected backends, coding tools, and platform', () => {
  assert.deepEqual(requiredSoftware({ ...target, tools: ['kimi'] }, 'linux'), ['bash', 'python3', 'dtach', 'kimi'])
  assert.deepEqual(requiredSoftware({ ...target, tools: ['claude'] }, 'darwin'), ['bash', 'python3', 'dtach', 'lsof', 'claude'])
  assert.deepEqual(requiredSoftware({ ...target, backends: ['tmux'], tools: ['codex'] }, 'darwin'), ['bash', 'python3', 'tmux', 'codex'])
  assert.deepEqual(requiredSoftware({ ...target, backends: ['tmux', 'dtach'], tools: ['kimi'] }, 'linux'), ['bash', 'python3', 'tmux', 'dtach', 'kimi'])
  assert.deepEqual(requiredSoftware({ ...target, backends: ['dtach', 'tmux'], tools: ['claude'] }, 'darwin'), ['bash', 'python3', 'dtach', 'tmux', 'lsof', 'claude'])
})

test('live shell inspection resolves interactive PATH, detects broken versions, bounds hanging probes, and leaves the registry absent', { skip: process.platform === 'win32', timeout: 20_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "outpost-software-é-'"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const bin = join(home, 'tools with spaces')
  await mkdir(bin)
  for (const profile of ['.bash_profile', '.zprofile']) await writeFile(join(home, profile), `. "$HOME/.bashrc"\n`)
  await writeFile(join(home, '.bashrc'), `case $- in *i*) ;; *) return ;; esac\nexport PATH=${quote(bin)}:"$PATH"\nprintf 'Startup chatter\\n'\n`)
  const write = (id, body) => writeFile(join(bin, id), `#!/bin/sh\n${body}\n`, { mode: 0o700 })
  await write('codex', "printf 'codex-cli 1.2.3 é\\n'")
  await write('kimi', "printf 'bad version executable\\n' >&2; exit 7")
  await write('claude', 'exec sleep 30')
  await write('python3', "printf 'Python 3.8.10\\n'")
  await write('dtach', "printf 'dtach - version 0.9\\n'")
  await write('tmux', "printf 'tmux 3.6\\n'")
  const client = new SoftwareClient({ ...process.env, HOME: home })
  const startedAt = Date.now()
  const report = await client.inspect(target)
  assert.ok(Date.now() - startedAt < 10_000, 'hanging version executable is bounded')
  assert.equal(report.environment.home, home)
  assert.equal(report.environment.uid, process.getuid())
  const status = id => report.software.find(item => item.id === id)
  assert.equal(status('codex').status, 'installed')
  assert.equal(status('codex').path, join(bin, 'codex'))
  assert.equal(status('codex').version, 'codex-cli 1.2.3 é')
  assert.equal(status('kimi').status, 'broken')
  assert.match(status('kimi').detail, /bad version executable/)
  assert.equal(status('claude').status, 'broken')
  assert.equal(status('python3').status, 'broken')
  assert.match(status('python3').detail, /3.9/)
  await assert.rejects(readFile(join(home, '.outpost/sessions.json')), { code: 'ENOENT' })
  await write('kimi', "printf 'kimi 0.41.0\\n'")
  await write('claude', "printf 'claude 2.0.0\\n'")
  assert.equal((await client.inspect(target)).software.find(item => item.id === 'kimi').status, 'installed', 'the next check reads the executable again')
  const both = await client.inspect({ ...target, backends: ['tmux', 'dtach'] })
  assert.equal(both.software.find(item => item.id === 'tmux').status, 'installed')
  assert.equal(both.software.find(item => item.id === 'dtach').status, 'installed')
  await assert.rejects(client.plan(target, 'tmux'), /not required/)
})

test('completed version probes remain successful when watchdog startup is delayed', { skip: process.platform === 'win32', timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'outpost-delayed-watchdog-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const bin = join(home, 'bin')
  await mkdir(bin)
  await writeFile(join(home, '.hushlogin'), '')
  await writeFile(join(home, '.bash_profile'), `export PATH=${quote(bin)}:"$PATH"\n`)
  // Reproduce an early cancellation signal arriving before the watchdog has
  // installed its handler. Only the inspection shell inherits ignored TERM.
  await writeFile(join(bin, 'sh'), '#!/bin/sh\nif [ "$1" = "-s" ]; then trap "" TERM; exec /bin/bash "$@"; fi\nexec /bin/sh "$@"\n', { mode: 0o700 })
  const bashEnv = join(home, 'bash-env')
  await writeFile(bashEnv, 'set -T\ntrap \'case "$BASH_COMMAND" in sleeper=*) /bin/sleep 0.1 ;; esac\' DEBUG\n')
  for (const [id, version] of [['python3', 'Python 3.12.0'], ['tmux', 'tmux 3.6'], ['codex', 'codex-cli 1.2.3']]) {
    await writeFile(join(bin, id), `#!/bin/sh\nprintf '%s\\n' ${quote(version)}\n`, { mode: 0o700 })
  }
  const client = new SoftwareClient({ ...process.env, HOME: home, SHELL: '/bin/bash', BASH_ENV: bashEnv })
  const report = await client.inspect({ ...target, backends: ['tmux'], tools: ['codex'] })
  for (const software of report.software) assert.equal(software.status, 'installed', JSON.stringify(software))
})

test('all installation presets are valid POSIX shell; coding tool presets use official installers', { skip: process.platform === 'win32' }, async () => {
  for (const id of ['bash', 'python3', 'tmux', 'dtach', 'lsof', 'codex', 'kimi', 'claude']) {
    const child = execute('sh', ['-n'])
    child.child.stdin.end(installationScript(id))
    await child
  }
  assert.match(installationScript('codex'), /https:\/\/chatgpt.com\/codex\/install.sh/)
  assert.match(installationScript('kimi'), /https:\/\/code.kimi.com\/kimi-code\/install.sh/)
  assert.match(installationScript('claude'), /https:\/\/claude.ai\/install.sh/)
})
