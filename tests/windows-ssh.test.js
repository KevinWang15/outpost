import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import ssh2 from 'ssh2'
import { DesktopLauncher } from '../backend/desktop.ts'
import { connectScript } from '../backend/sessions.ts'
import { terminalScript } from '../backend/terminal.ts'

const execute = promisify(execFile)
const { Server } = ssh2
function run(executable, args, options) {
  const pending = execute(executable, args, options)
  pending.child.stdin.end()
  return pending
}

test(
  'desktop PowerShell preserves the full SSH command with Git SSH first in the manager PATH',
  {
    skip: process.platform !== 'win32' && !process.env.OUTPOST_PWSH,
    timeout: 60_000,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'outpost-windows-ssh-'))
    const connections = new Set()
    const commands = []
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    })
    const server = new Server({ hostKeys: [privateKey] }, (client) => {
      connections.add(client)
      client.on('error', () => {})
      client.on('close', () => connections.delete(client))
      client.on('authentication', (context) => context.accept())
      client.on('ready', () =>
        client.on('session', (accept) => {
          const session = accept()
          session.on('pty', (acceptPty) => acceptPty())
          session.on('exec', (acceptExec, _reject, info) => {
            commands.push(info.command)
            const stream = acceptExec()
            stream.write('OUTPOST_REAL_SSH_OK\n')
            stream.exit(0)
            stream.end()
          })
        }),
      )
    })
    t.after(async () => {
      for (const client of connections) client.end()
      await new Promise((resolve) => server.close(resolve))
      await rm(directory, { recursive: true, force: true })
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const config = join(directory, 'ssh-config')
    await writeFile(config, '')
    const target = {
      kind: 'ssh',
      name: 'Loopback fixture',
      id: 'fixture',
      host: '127.0.0.1',
      port: server.address().port,
      backends: ['tmux'],
      tools: ['codex'],
      environment: {
        shell: '/bin/bash',
        home: '/root',
        uid: 0,
        username: 'root',
        platform: 'linux',
      },
    }
    // Use the full runtime command: a short printf misses its nested shell quotes.
    const script = connectScript(target, 'session', 'powershell')
    const command = JSON.parse(
      Buffer.from(
        script.match(/FromBase64String\('([^']+)'\)/)[1],
        'base64',
      ).toString(),
    )
    command.args = [
      '-F',
      config,
      '-o',
      `UserKnownHostsFile=${join(directory, 'known-hosts')}`,
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'BatchMode=yes',
      // This loopback server checks command delivery, not terminal emulation.
      ...command.args.map((argument) => (argument === '-tt' ? '-T' : argument)),
    ]
    const expected = command.args.at(-1)
    const windows = process.platform === 'win32'
    const binary = windows
      ? join(process.env.WINDIR, 'System32', 'OpenSSH', 'ssh.exe')
      : 'ssh'
    const env = {
      ...process.env,
      OUTPOST_SSH_SOURCE: join(directory, 'source.txt'),
    }
    if (windows) {
      await access(binary)
      const gitDirectory = join(process.env.ProgramFiles, 'Git', 'usr', 'bin')
      await access(join(gitDirectory, 'ssh.exe'))
      const pathKey = Object.keys(env).find(
        (key) => key.toLowerCase() === 'path',
      )
      env[pathKey] = gitDirectory + ';' + env[pathKey]
    }
    const runtimes =
      process.platform === 'win32'
        ? ['powershell.exe', 'pwsh.exe']
        : [process.env.OUTPOST_PWSH]
    for (const runtime of runtimes) {
      await t.test(runtime, async () => {
        const makeScript = () =>
          '[IO.File]::WriteAllText($env:OUTPOST_SSH_SOURCE, (Get-Command ssh -CommandType Application | Select-Object -First 1).Source)\n' +
          terminalScript(command, 'powershell')
        const copied = join(directory, 'copied.ps1')
        await writeFile(
          copied,
          terminalScript({ ...command, executable: binary }, 'powershell'),
        )
        const copyResult = await run(
          runtime,
          ['-NoLogo', '-NoProfile', '-File', copied],
          { env, timeout: 15_000 },
        )
        assert.match(copyResult.stdout, /OUTPOST_REAL_SSH_OK/)
        assert.equal(
          commands.at(-1),
          expected,
          'copied script preserves the command received by the SSH server',
        )
        const launcher = new DesktopLauncher(
          {
            platform: 'win32',
            env,
            executable: async (name) => name,
            application: async () => null,
            query: async () => 'True',
            ownsConsole: async () => true,
            start: async (_file, args) => {
              const result = await run(
                runtime,
                [
                  '-NoLogo',
                  '-NoProfile',
                  '-NonInteractive',
                  '-EncodedCommand',
                  args.at(-1),
                ],
                { env, timeout: 15_000 },
              )
              assert.match(result.stdout, /OUTPOST_REAL_SSH_OK/)
            },
          },
          directory,
        )
        await launcher.launch(makeScript)
        if (windows)
          assert.equal(
            (await readFile(env.OUTPOST_SSH_SOURCE, 'utf8')).toLowerCase(),
            binary.toLowerCase(),
            'GUI launch selects Windows OpenSSH instead of inherited Git SSH',
          )
        assert.equal(
          commands.at(-1),
          expected,
          'desktop bootstrap preserves the command received by the SSH server',
        )
        assert.ok(
          !(await readdir(directory)).some((name) =>
            name.startsWith('outpost-terminal-'),
          ),
        )
      })
    }
  },
)
