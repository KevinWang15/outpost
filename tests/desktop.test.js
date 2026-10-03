import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { connectScript } from '../backend/sessions.ts'
import { DesktopLauncher, desktopHost, powershellBootstrap } from '../backend/desktop.ts'
import { terminalApps, terminalOS } from '../shared/terminals.ts'

const execute = promisify(execFile)
const target = { id: 'target', name: 'Dev', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev-alias', port: 2222, backends: ['tmux'], identityFile: "~/key with 'quotes", createdAt: new Date().toISOString() }
function fakeHost(overrides = {}) {
  return {
    platform: 'linux', env: { DISPLAY: ':1' },
    executable: async name => ['bash', 'gnome-terminal'].includes(name) ? `/usr/bin/${name}` : null,
    application: async name => name === 'Terminal' ? '/Applications/Terminal.app' : null,
    query: async () => 'True', ownsConsole: async () => true, start: async () => {},
    ...overrides,
  }
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-desktop-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('desktop detection distinguishes desktop sessions, missing terminals, and headless hosts', async () => {
  for (const host of [
    fakeHost({ env: {} }), fakeHost({ executable: async () => null }),
    fakeHost({ platform: 'darwin', ownsConsole: async () => false }),
    fakeHost({ platform: 'win32', executable: async name => name, query: async () => 'False' }),
    fakeHost({ platform: 'win32', executable: async name => name, query: async () => { throw new Error('unavailable') } }),
    fakeHost({ platform: 'freebsd' }),
  ]) {
    const launcher = new DesktopLauncher(host)
    assert.deepEqual(await launcher.available(), { os: terminalOS(host.platform), terminals: [], recommendedId: null })
    await assert.rejects(launcher.launch(shell => connectScript(target, 'session', shell)), /No desktop terminal/)
  }
  assert.equal((await new DesktopLauncher(fakeHost({ env: { WAYLAND_DISPLAY: 'wayland-0' } })).available()).recommendedId, 'linux-gnome')
  assert.equal((await new DesktopLauncher(fakeHost({ platform: 'darwin' })).available()).recommendedId, 'macos-terminal')
  assert.equal((await new DesktopLauncher(fakeHost({ platform: 'win32', executable: async name => name })).available()).recommendedId, 'windows-terminal')
  assert.equal((await new DesktopLauncher(fakeHost({ platform: 'win32', executable: async name => name === 'powershell.exe' ? name : null })).available()).recommendedId, 'windows-console')
})

test('discovery returns every available app in recommendation order for each OS', async () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const os = terminalOS(platform)
    const launcher = new DesktopLauncher(fakeHost({ platform, executable: async name => name, application: async name => `/Applications/${name}.app` }))
    const terminals = terminalApps.filter(app => app.os === os)
    assert.deepEqual(await launcher.available(), { os, terminals, recommendedId: terminals[0].id })
  }
})

test('macOS and Linux launch private scripts as literal arguments and clean up startup failures', async t => {
  const directory = await temporary(t)
  const root = join(directory, "spaces 'quotes' & $(literal) é")
  await mkdir(root)
  for (const [platform, terminal, expected] of [
    ['darwin', 'Terminal', ['/usr/bin/open', '-a', '/Applications/Terminal.app']],
    ['darwin', 'WezTerm', ['/usr/bin/open', '-n', '-a', '/Applications/WezTerm.app', '--args', 'start', '--always-new-process', '--', '/bin/bash']],
    ['darwin', 'kitty', ['/usr/bin/open', '-n', '-a', '/Applications/kitty.app', '--args', '--session', 'none', '/bin/bash']],
    ['darwin', 'Alacritty', ['/usr/bin/open', '-n', '-a', '/Applications/Alacritty.app', '--args', '-e', '/bin/bash']],
    ['linux', 'gnome-terminal', ['/usr/bin/gnome-terminal', '--', '/usr/bin/bash']],
    ['linux', 'ptyxis', ['/usr/bin/ptyxis', '--standalone', '--', '/usr/bin/bash']],
    ['linux', 'konsole', ['/usr/bin/konsole', '-e', '/usr/bin/bash']],
    ['linux', 'wezterm', ['/usr/bin/wezterm', 'start', '--always-new-process', '--', '/usr/bin/bash']],
    ['linux', 'kitty', ['/usr/bin/kitty', '--detach', '--session', 'none', '/usr/bin/bash']],
    ['linux', 'alacritty', ['/usr/bin/alacritty', '-e', '/usr/bin/bash']],
    ['linux', 'xfce4-terminal', ['/usr/bin/xfce4-terminal', '--disable-server', '--execute', '/usr/bin/bash']],
    ['linux', 'xterm', ['/usr/bin/xterm', '-e', '/usr/bin/bash']],
  ]) {
    const launcher = new DesktopLauncher(fakeHost({
      platform,
      executable: async name => ['bash', terminal].includes(name) ? `/usr/bin/${name}` : null,
      application: async name => name === terminal ? `/Applications/${name}.app` : null,
      start: async (file, args) => {
        assert.deepEqual([file, ...args.slice(0, -1)], expected)
        const script = args.at(-1)
        assert.ok(script.startsWith(root))
        const contents = await readFile(script, 'utf8')
        assert.match(contents, /dev-alias/)
        assert.match(contents, /Connection failed/)
        if (process.platform !== 'win32') assert.equal((await stat(script)).mode & 0o777, 0o700)
        throw new Error('display unavailable')
      },
    }), root)
    await assert.rejects(launcher.launch(shell => connectScript(target, 'session', shell)), /display unavailable.*Copy command/)
    assert.deepEqual(await readdir(root), [], 'failed launches leave no script behind')
  }
})

test('Windows Terminal launch keeps scripts out of native command-line limits and preserves literal paths', async t => {
  const root = await temporary(t)
  let launched
  const launcher = new DesktopLauncher(fakeHost({
    platform: 'win32', executable: async name => name,
    start: async (file, args, hidden) => { launched = { file, args, hidden } },
  }), root)
  await launcher.launch(shell => connectScript(target, 'session', shell))
  assert.equal(launched.file, 'wt.exe')
  assert.equal(launched.hidden, false)
  assert.deepEqual(launched.args.slice(0, -1), ['-w', 'new', 'new-tab', 'pwsh.exe', '-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand'])
  const bootstrap = Buffer.from(launched.args.at(-1), 'base64').toString('utf16le')
  assert.match(bootstrap, /ReadAllText/)
  assert.ok(launched.args.join(' ').length < 10_000)
  assert.doesNotMatch(bootstrap, /ExecutionPolicy|dev-alias/)
  const paths = JSON.parse(Buffer.from(bootstrap.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString())
  assert.ok(paths.file.startsWith(root))
  assert.match(await readFile(paths.file, 'utf8'), /System.Diagnostics.ProcessStartInfo/)
})

test('automatic launch honors the host OS favorite and falls back after an unavailable or failed choice', async t => {
  const root = await temporary(t)
  const starts = []
  let failFavorite = true
  const launcher = new DesktopLauncher(fakeHost({
    executable: async name => ['bash', 'gnome-terminal', 'xterm'].includes(name) ? name : null,
    start: async (executable, args) => {
      starts.push(executable)
      if (executable === 'xterm' && failFavorite) throw new Error('cannot open display')
      // Simulate the successful terminal consuming its private script.
      await rm(join(args.at(-1), '..'), { recursive: true })
    },
  }), root)
  assert.equal((await launcher.launch(() => 'echo ok', { preferences: { linux: 'linux-xterm', macos: 'macos-iterm2' } })).id, 'linux-gnome')
  assert.deepEqual(starts, ['xterm', 'gnome-terminal'])
  assert.deepEqual(await readdir(root), [])
  starts.length = 0
  failFavorite = false
  assert.equal((await launcher.launch(() => 'echo ok', { preferences: { linux: 'linux-xterm' } })).id, 'linux-xterm')
  assert.deepEqual(starts, ['xterm'])
  failFavorite = true
  starts.length = 0
  assert.equal((await launcher.launch(() => 'echo ok', { preferences: { linux: 'linux-kitty' } })).id, 'linux-gnome')
  assert.deepEqual(starts, ['gnome-terminal'])
  starts.length = 0
  await assert.rejects(launcher.launch(() => 'echo ok', { terminalId: 'linux-xterm' }), /cannot open display/)
  assert.deepEqual(starts, ['xterm'], 'explicit selections never silently open a different app')
  await assert.rejects(launcher.launch(() => 'echo ok', { terminalId: 'macos-iterm2' }), /selected terminal is unavailable/)
  assert.deepEqual(await readdir(root), [])
})

test('Windows alternatives use the selected PowerShell shell and hide a WezTerm CLI fallback launcher', async t => {
  const root = await temporary(t)
  for (const [id, executable, prefix, hidden] of [
    ['windows-wezterm', 'wezterm.exe', ['start', '--always-new-process', '--', 'powershell.exe'], true],
    ['windows-alacritty', 'alacritty.exe', ['-e', 'powershell.exe'], false],
  ]) {
    const launcher = new DesktopLauncher(fakeHost({
      platform: 'win32', executable: async name => [executable, 'powershell.exe'].includes(name) ? name : null,
      start: async (file, args, isHidden) => {
        assert.equal(file, executable)
        assert.equal(isHidden, hidden)
        assert.deepEqual(args.slice(0, prefix.length), prefix)
        const bootstrap = Buffer.from(args.at(-1), 'base64').toString('utf16le')
        const paths = JSON.parse(Buffer.from(bootstrap.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString())
        assert.match(await readFile(paths.file, 'utf8'), /Write-Output ok/)
        await rm(paths.directory, { recursive: true })
      },
    }), root)
    assert.equal((await launcher.launch(() => 'Write-Output ok', { terminalId: id })).id, id)
    assert.deepEqual(await readdir(root), [])
  }
})

test('iTerm2 launches a new profile window with literal script paths and automatically falls back to Terminal', async t => {
  const directory = await temporary(t)
  const root = join(directory, "O’Brien 'quotes' $(literal) é")
  await mkdir(root)
  const starts = []
  const launcher = new DesktopLauncher(fakeHost({
    platform: 'darwin', application: async name => ['iTerm', 'Terminal'].includes(name) ? `/Applications/${name}.app` : null,
    start: async (executable, args, _hidden, waitForExit) => {
      starts.push(executable)
      const file = args.at(-1)
      assert.ok(file.startsWith(root))
      assert.match(await readFile(file, 'utf8'), /echo ok/)
      if (executable.endsWith('osascript')) {
        assert.equal(waitForExit, true, 'wait for automation errors before reporting success')
        assert.equal(args[0], '-e')
        assert.match(args[1], /create window with default profile command/)
        assert.match(args[1], /quoted form of \(item 1 of argv\)/)
        assert.ok(!args[1].includes(root), 'user paths are data, never AppleScript source')
        throw new Error('automation permission denied')
      }
      assert.deepEqual(args.slice(0, -1), ['-a', '/Applications/Terminal.app'])
      await rm(join(file, '..'), { recursive: true })
    },
  }), root)
  assert.equal((await launcher.launch(() => 'echo ok')).id, 'macos-terminal')
  assert.deepEqual(starts, ['/usr/bin/osascript', '/usr/bin/open'])
  assert.deepEqual(await readdir(root), [])
  starts.length = 0
  await assert.rejects(launcher.launch(() => 'echo ok', { terminalId: 'macos-iterm2' }), /automation permission denied/)
  assert.deepEqual(starts, ['/usr/bin/osascript'])
})

test('Windows Terminal can fall back to the system console and launch an explicitly selected alternative', async t => {
  const root = await temporary(t)
  const starts = []
  const launcher = new DesktopLauncher(fakeHost({
    platform: 'win32', executable: async name => name,
    start: async (executable, args, hidden) => {
      starts.push(executable)
      if (executable === 'wt.exe') throw new Error('Windows Terminal unavailable')
      if (executable === 'pwsh.exe') { assert.equal(hidden, true); assert.match(Buffer.from(args.at(-1), 'base64').toString('utf16le'), /Start-Process/) }
      else assert.deepEqual(args.slice(0, 4), ['start', '--always-new-process', '--', 'pwsh.exe'])
      for (const directory of await readdir(root)) await rm(join(root, directory), { recursive: true })
    },
  }), root)
  assert.equal((await launcher.launch(() => 'Write-Output ok')).id, 'windows-console')
  assert.deepEqual(starts, ['wt.exe', 'pwsh.exe'])
  starts.length = 0
  assert.equal((await launcher.launch(() => 'Write-Output ok', { terminalId: 'windows-wezterm' })).id, 'windows-wezterm')
  assert.deepEqual(starts, ['wezterm-gui.exe'])
  assert.deepEqual(await readdir(root), [])
})

const runtimes = process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : process.env.OUTPOST_PWSH ? [process.env.OUTPOST_PWSH] : []
test('PowerShell launch bootstrap runs and cleans private scripts with spaces, punctuation, and Unicode quotes', { skip: !runtimes.length, timeout: 30_000 }, async t => {
  const root = await temporary(t)
  for (const runtime of runtimes) {
    const directory = join(root, "O’Brien ‘quotes’ & $(literal) ` space")
    await mkdir(directory)
    const file = join(directory, 'connect.ps1')
    await writeFile(file, 'Write-Output "OUTPOST_DESKTOP_OK"', { mode: 0o700 })
    const script = Buffer.from(powershellBootstrap(file, directory), 'utf16le').toString('base64')
    const result = await execute(runtime, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', script])
    assert.match(result.stdout, /OUTPOST_DESKTOP_OK/)
    await assert.rejects(stat(directory), { code: 'ENOENT' })
  }
})

test('GUI launcher surfaces immediate process failures', { skip: process.platform === 'win32' }, async () => {
  const host = desktopHost()
  await assert.rejects(host.start('/outpost-missing-terminal', []), /ENOENT/)
  await assert.rejects(host.start('/bin/sh', ['-c', 'exit 23']), /code 23/)
  await assert.rejects(host.start('/bin/sh', ['-c', 'sleep 1; exit 24'], false, true), /code 24/)
  await assert.rejects(host.start('/bin/sh', ['-c', 'printf "automation denied" >&2; exit 1'], false, true), /automation denied/)
})

test('native Windows fallback opens PowerShell with its own interactive console', {
  skip: process.platform !== 'win32' || !process.env.OUTPOST_DESKTOP_NATIVE,
  timeout: 30_000,
}, async t => {
  const root = await temporary(t)
  const capture = join(root, 'console.json')
  const launchRoot = join(root, "launch O’Brien & literal")
  await mkdir(launchRoot)
  const powershell = await desktopHost().executable('powershell.exe')
  assert.ok(powershell)
  const launcher = new DesktopLauncher(fakeHost({
    platform: 'win32', executable: async name => name === 'powershell.exe' ? powershell : null,
    start: async (file, args, hidden) => {
      assert.equal(file, powershell)
      assert.equal(hidden, true)
      const script = join(launchRoot, (await readdir(launchRoot))[0], 'connect.ps1')
      // Exercise the real Start-Process/console/bootstrap chain without target SSH.
      await writeFile(script, `try {
  $result = @{ input = [Console]::IsInputRedirected; output = [Console]::IsOutputRedirected; error = [Console]::IsErrorRedirected } | ConvertTo-Json
  [IO.File]::WriteAllText($env:OUTPOST_CONSOLE_CAPTURE, $result)
} finally { exit }
`)
      await execute(file, args, { env: { ...process.env, OUTPOST_CONSOLE_CAPTURE: capture }, windowsHide: hidden, timeout: 10_000 })
    },
  }), launchRoot)
  assert.deepEqual(await launcher.launch(shell => connectScript(target, 'session', shell)), terminalApps.find(app => app.id === 'windows-console'))
  let result
  const deadline = Date.now() + 10_000
  while (!result && Date.now() < deadline) {
    try { result = JSON.parse(await readFile(capture, 'utf8')) } catch { await delay(100) }
  }
  assert.deepEqual(result, { input: false, output: false, error: false })
  assert.deepEqual(await readdir(launchRoot), [])
})
