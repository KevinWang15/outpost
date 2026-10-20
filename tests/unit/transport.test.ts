import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SshTarget } from '../../shared/model'
import { sshArgs, transportFor } from '../../backend/transport'

const target: SshTarget = {
  id: 't',
  name: 'dev',
  createdAt: '',
  kind: 'ssh',
  host: 'dev.example.com',
  port: 2222,
  tools: ['claude'],
  identityFile: '~/.ssh/key',
}
const option = (args: string[], name: string) =>
  args.find((value, index) => args[index - 1] === '-o' && value.startsWith(`${name}=`))

// Exercise policy on every host without running platform-specific executables.
// Each override is synchronous and restored before another test can run.
function onPlatform<T>(platform: NodeJS.Platform, action: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...original, value: platform })
  try {
    return action()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

test('local mode uses your SSH configuration and identity file', () => {
  const args = sshArgs(target, null, { scope: 'local' })
  assert.deepEqual(args.slice(-4), ['-l', 'root', '--', 'dev.example.com'])
  assert.ok(args.includes('-T') && args.includes('BatchMode=yes'))
  assert.equal(args[args.indexOf('-i') + 1], join(homedir(), '.ssh/key'))
  assert.ok(!args.includes('-F'))
  assert.equal(option(args, 'ControlPath'), 'ControlPath=none')
  assert.equal(option(args, 'ControlMaster'), 'ControlMaster=no')
  assert.equal(option(args, 'ControlPersist'), 'ControlPersist=no')
})

test('hosted mode uses only the account key and known hosts', () => {
  const args = sshArgs(
    target,
    { identityFile: '/data/users/u/ssh-key', knownHostsFile: '/data/users/u/known_hosts' },
    { scope: 'u' },
  )
  assert.deepEqual(args.slice(args.indexOf('-F'), args.indexOf('-F') + 2), ['-F', 'none'])
  assert.equal(option(args, 'IdentityAgent'), 'IdentityAgent=none')
  assert.equal(option(args, 'UserKnownHostsFile'), 'UserKnownHostsFile="/data/users/u/known_hosts"')
  assert.equal(args[args.indexOf('-i') + 1], '/data/users/u/ssh-key')
})

test('connection sharing never crosses owners or identities', () =>
  onPlatform('linux', () => {
    const path = (scope: string, identity = '/k') =>
      option(
        sshArgs(target, { identityFile: identity, knownHostsFile: '/h' }, { scope, multiplex: '/data/ssh' }),
        'ControlPath',
      )!
    assert.match(path('alice').replaceAll('\\', '/'), /^ControlPath=\/data\/ssh\/[0-9a-f]{12}-%C$/)
    assert.equal(path('alice'), path('alice'))
    assert.notEqual(path('alice'), path('bob'))
    assert.notEqual(path('alice', '/k1'), path('alice', '/k2'))
  }))

for (const platform of ['win32', 'linux', 'darwin'] as const) {
  test(`${platform} backend applies the same sharing policy to management and runtime`, () =>
    onPlatform(platform, () => {
      const transport = transportFor(target, null, { scope: 'local', multiplex: '/data/ssh' })
      const commands = [
        transport.management('interactive'),
        transport.management('noninteractive'),
        transport.runtime('command'),
      ]
      for (const command of commands) {
        if (platform === 'win32') {
          assert.equal(option(command.args, 'ControlMaster'), 'ControlMaster=no')
          assert.equal(option(command.args, 'ControlPath'), 'ControlPath=none')
          assert.equal(option(command.args, 'ControlPersist'), 'ControlPersist=no')
          assert.equal(command.retry, undefined)
        } else {
          assert.equal(option(command.args, 'ControlMaster'), 'ControlMaster=auto')
          assert.equal(option(command.args, 'ControlPersist'), 'ControlPersist=120')
          assert.ok(command.retry)
        }
      }
    }))
}

test('fresh-connection recovery preserves destination, identity, host checking and command', () =>
  onPlatform('linux', () => {
    for (const identity of [null, { identityFile: '/account/key', knownHostsFile: '/account/known hosts' }]) {
      const transport = transportFor(target, identity, { scope: 'alice', multiplex: '/data/ssh' })
      for (const command of [transport.runtime('original command'), transport.management('interactive')]) {
        const retry = command.retry!
        assert.equal(option(retry.args, 'ControlMaster'), 'ControlMaster=no')
        assert.equal(option(retry.args, 'ControlPath'), 'ControlPath=none')
        assert.equal(option(retry.args, 'ControlPersist'), 'ControlPersist=no')
        const withoutSharing = (args: string[]) =>
          args.filter(
            (value, index) =>
              !/^Control(?:Master|Path|Persist)=/.test(value) &&
              !(value === '-o' && /^Control(?:Master|Path|Persist)=/.test(args[index + 1] ?? '')),
          )
        assert.deepEqual(withoutSharing(command.args), withoutSharing(retry.args))
      }
      assert.equal(transportFor(target, identity, { scope: 'alice' }).runtime('command').retry, undefined)
    }
  }))

test('only unambiguous control-connection failures qualify for recovery', () => {
  const retry = onPlatform(
    'linux',
    () => transportFor(target, null, { scope: 'local', multiplex: '/data/ssh' }).runtime('command').retry!,
  )
  const mux = 'mux_client_request_session: read from master failed: Connection reset by peer'
  const accepts = (stderr: string, stdout = '', code: number | null = 255) => retry.when({ code, stdout, stderr })
  for (const stderr of [
    mux,
    `${mux}\nFailed to connect to new control master\n`,
    `\r\n  ${mux}\r\nFailed to connect to new control master\r\n`,
    'mux_client_request_alive: read from master failed: Broken pipe',
    'mux_client_request_session: write packet: Broken pipe',
    'mux_client_request_session: send fds failed',
    'muxclient: master hello exchange failed',
    'Control master terminated unexpectedly',
  ])
    assert.equal(accepts(stderr), true, stderr)

  for (const diagnostic of [
    'root@dev: Permission denied (publickey).',
    'Host key verification failed.',
    'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!',
    '/home/user/.ssh/config: line 3: Bad configuration option: invalid',
    '/home/user/.ssh/config: terminating, 1 bad configuration options',
    'Load key "/key": invalid format',
    'ssh: Could not resolve hostname dev: Name or service not known',
    'ssh: connect to host dev port 22: Connection refused',
    'Connection reset by 127.0.0.1 port 6622',
    'Remote command failed for an unknown reason',
  ]) {
    assert.equal(accepts(diagnostic), false, diagnostic)
    assert.equal(accepts(`${mux}\n${diagnostic}`), false, diagnostic)
    assert.equal(accepts(`${diagnostic}\n${mux}`), false, diagnostic)
  }
  assert.equal(accepts(' \r\n'), false)
  for (const stdout of ['partial output', 'OUTPOST_RESULT:{"ok":false,"error":{}}\n', ' '])
    assert.equal(accepts(mux, stdout), false)
  for (const code of [0, 1, null]) assert.equal(accepts(mux, '', code), false)
})
