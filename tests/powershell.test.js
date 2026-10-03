import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { inflateSync } from 'node:zlib'
import test from 'node:test'
import { createApp } from '../backend/app.ts'
import { connectScript } from '../backend/sessions.ts'
import { terminalScript } from '../backend/terminal.ts'
import { LocalTransport } from '../backend/local.ts'
import { TargetStore } from '../backend/store.ts'

const execute = promisify(execFile)
const windows = process.platform === 'win32'
const runtimes = windows ? ['powershell.exe', 'pwsh.exe'] : process.env.OUTPOST_PWSH ? [process.env.OUTPOST_PWSH] : []

test('SSH attachment payload stays within its Windows command-line budget without a PowerShell runtime', () => {
  const target = { kind: 'ssh', id: 'target', name: 'Payload fixture', host: 'dev-alias', port: 2222,
    tools: ['codex', 'claude', 'kimi'], backends: ['tmux', 'dtach'], identityFile: '~/keys/space & é', createdAt: '2026-10-03T00:00:00Z' }
  const script = connectScript(target, '12345678-1234-4123-8123-123456789012', 'powershell')
  const encoded = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)[1]
  const command = JSON.parse(Buffer.from(encoded, 'base64').toString())
  assert.equal(command.executable, 'ssh')
  const length = command.args.at(-1).length
  assert.ok(length < 20_000, `SSH attachment is ${length} characters; its budget is 20,000`)
})

test('PowerShell downloads preserve native SSH arguments, home paths, output, and errors', { skip: !runtimes.length && 'Set OUTPOST_PWSH to test PowerShell on Unix', timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-powershell-'))
  const bin = join(directory, "space's & unicode-é")
  await mkdir(bin)
  const capture = join(directory, 'args.txt')
  const store = new TargetStore(join(directory, 'manager'))
  const app = await createApp({ store, service: { get: async () => ({ id: 'session' }) }, desktop: { available: async () => ({ os: 'linux', terminals: [], recommendedId: null }) } })
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }) })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const host = `127.0.0.1:${app.server.address().port}`
  const env = { ...process.env, OUTPOST_CAPTURE: capture, TERM: 'outpost-original-term' }
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path')
  env[pathKey] = bin + (windows ? ';' : ':') + env[pathKey]
  if (windows) {
    const source = join(directory, 'Capture.cs')
    await writeFile(source, `using System; using System.IO; using System.Text;
public class Capture {
  public static int Main(string[] args) {
    File.WriteAllLines(Environment.GetEnvironmentVariable("OUTPOST_CAPTURE"), Array.ConvertAll(args, x => Convert.ToBase64String(Encoding.UTF8.GetBytes(x))));
    Console.WriteLine("OUTPOST_SSH_OUTPUT");
    Console.WriteLine("OUTPOST_SSH_TERM=" + (Environment.GetEnvironmentVariable("TERM") ?? ""));
    return Environment.GetEnvironmentVariable("OUTPOST_SSH_FAIL") == "1" ? 23 : 0;
  }
}`)
    await execute('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -Path $env:OUTPOST_SOURCE -OutputAssembly $env:OUTPOST_EXE -OutputType ConsoleApplication'], {
      env: { ...env, OUTPOST_SOURCE: source, OUTPOST_EXE: join(bin, 'ssh.exe') },
    })
  } else {
    await writeFile(join(bin, 'ssh'), `#!/usr/bin/env python3
import base64, os, sys
with open(os.environ['OUTPOST_CAPTURE'], 'w') as f:
    f.write('\\n'.join(base64.b64encode(a.encode()).decode() for a in sys.argv[1:]))
print('OUTPOST_SSH_OUTPUT', flush=True)
print('OUTPOST_SSH_TERM=' + os.environ.get('TERM', ''), flush=True)
sys.exit(23 if os.environ.get('OUTPOST_SSH_FAIL') == '1' else 0)
`, { mode: 0o700 })
  }
  const identities = ["~/keys/space's & é", windows ? 'C:\\Users\\Dev User\\key\\' : '/tmp/key with "quotes" and \\', windows ? "C:\\keys\\dollar$(whoami)`'&é" : "/tmp/dollar$(whoami)`'&é"]
  identities.push("~/keys/O’Brien ‘quotes’ $(whoami)")
  for (const runtime of runtimes) for (const [index, identityFile] of identities.entries()) {
    const id = randomUUID()
    await store.add({ id, name: id, tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev-alias', port: 2222, backends: ['tmux'], identityFile, createdAt: new Date().toISOString() })
    const response = await app.inject({ method: 'POST', url: `/api/targets/${id}/sessions/session/connect`, headers: { host, 'x-outpost-request': '1' } })
    assert.equal(response.statusCode, 200, response.body)
    const connection = response.json()
    const result = await execute(runtime, ['-NoProfile', '-Command', `${connection.commands.powershell}; Write-Output "TERM=$env:TERM"`], { env })
    assert.match(result.stdout, /OUTPOST_SSH_OUTPUT/)
    assert.match(result.stdout, /TERM=outpost-original-term/)
    assert.match(result.stdout, /OUTPOST_SSH_TERM=outpost-original-term/, 'a usable client TERM reaches SSH unchanged')
    if (index === 0) {
      const dumb = await execute(runtime, ['-NoProfile', '-Command', connection.commands.powershell], { env: { ...env, TERM: 'dumb' } })
      assert.match(dumb.stdout, /OUTPOST_SSH_TERM=xterm-256color/, 'TERM=dumb leaked from a non-terminal manager is replaced for SSH')
    }
    const args = (await readFile(capture, 'utf8')).trim().split(/\r?\n/).map(line => Buffer.from(line, 'base64').toString())
    assert.deepEqual(args.slice(0, -1), ['-tt', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=accept-new', '-p', '2222', '-i', identityFile.startsWith('~/') ? join(homedir(), identityFile.slice(2)) : identityFile, '-l', 'root', '--', 'dev-alias'])
    assert.match(args.at(-1), /^bash -lic /)
    assert.ok(args.at(-1).length < 20_000, 'fits within Windows native command-line limits')
    const encoded = args.at(-1).match(/b64decode\("([A-Za-z0-9+/=]+)"\)/)[1]
    const program = inflateSync(Buffer.from(encoded, 'base64')).toString()
    assert.ok(program.endsWith(await readFile(new URL('../backend/session-runtime.py', import.meta.url), 'utf8')))
    for (const tool of ['codex', 'claude', 'kimi']) assert.ok(program.includes(`outpost_${tool}_adapter`))
    assert.equal(program.includes('class Scan:'), false, 'attachment excludes history-search code to fit native Windows command-line limits')
    await assert.rejects(execute(runtime, ['-NoProfile', '-Command', connection.commands.powershell], { env: { ...env, OUTPOST_SSH_FAIL: '1' } }), error => /SSH exited with code 23/.test(error.stderr))
    if (windows && index === 0) {
      // cmd parses the short wrapper; PowerShell fetches the full script over HTTP.
      const cmd = await execute('cmd.exe', ['/d', '/s', '/c', `"${connection.commands.cmd}"`], { env, windowsVerbatimArguments: true })
      assert.match(cmd.stdout, /OUTPOST_SSH_OUTPUT/)
      const missing = connection.commands.powershell.replace('/api/connect/', '/api/connect/invalid-')
      await rm(capture)
      await assert.rejects(execute(runtime, ['-NoProfile', '-Command', missing], { env }))
      await assert.rejects(readFile(capture), { code: 'ENOENT' }, 'invalid downloads never launch SSH')
    }
  }
  await copyFile(join(bin, windows ? 'ssh.exe' : 'ssh'), join(bin, 'wsl.exe'))
  const wsl = new LocalTransport({ tools: ['codex', 'kimi', 'claude'], kind: 'local', id: 'wsl', name: 'Local WSL', backends: ['dtach'],
    distribution: "Ubuntu Dev’s 'quotes' $(literal)", environment: { username: 'dev', shell: '/bin/zsh' },
  }, 'win32')
  const command = wsl.attach("printf '%s' 'literal argument with spaces and $dollars'")
  const script = join(directory, 'wsl.ps1')
  await writeFile(script, terminalScript(command, 'powershell'))
  for (const runtime of runtimes) {
    await execute(runtime, ['-NoProfile', '-File', script], { env })
    const args = (await readFile(capture, 'utf8')).trim().split(/\r?\n/).map(line => Buffer.from(line, 'base64').toString())
    assert.deepEqual(args, command.args, 'WSL gets literal distribution, user, shell, and operation arguments')
    await assert.rejects(execute(runtime, ['-NoProfile', '-File', script], { env: { ...env, OUTPOST_SSH_FAIL: '1' } }), error => /WSL exited with code 23/.test(error.stderr))
  }

})
