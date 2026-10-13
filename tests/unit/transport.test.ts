import assert from 'node:assert/strict'
import test from 'node:test'
import type { SshTarget } from '../../shared/model'
import { sshArgs } from '../../backend/transport'

const target: SshTarget = { id: 't', name: 'dev', createdAt: '', kind: 'ssh', host: 'dev.example.com', port: 2222, tools: ['claude'], identityFile: '~/.ssh/key' }
const option = (args: string[], name: string) => args.find((value, index) => args[index - 1] === '-o' && value.startsWith(`${name}=`))

test('local mode uses your SSH configuration and identity file', () => {
  const args = sshArgs(target, null, { scope: 'local' })
  assert.deepEqual(args.slice(-4), ['-l', 'root', '--', 'dev.example.com'])
  assert.ok(args.includes('-T') && args.includes('BatchMode=yes'))
  assert.equal(args[args.indexOf('-i') + 1].endsWith('/.ssh/key'), true)
  assert.ok(!args.includes('-F'))
  assert.equal(option(args, 'ControlPath'), undefined)
})

test('hosted mode uses only the account key and known hosts', () => {
  const args = sshArgs(target, { identityFile: '/data/users/u/ssh-key', knownHostsFile: '/data/users/u/known_hosts' }, { scope: 'u' })
  assert.deepEqual(args.slice(args.indexOf('-F'), args.indexOf('-F') + 2), ['-F', 'none'])
  assert.equal(option(args, 'IdentityAgent'), 'IdentityAgent=none')
  assert.equal(option(args, 'UserKnownHostsFile'), 'UserKnownHostsFile="/data/users/u/known_hosts"')
  assert.equal(args[args.indexOf('-i') + 1], '/data/users/u/ssh-key')
})

test('connection sharing never crosses owners or identities', () => {
  const path = (scope: string, identity = '/k') => option(sshArgs(target, { identityFile: identity, knownHostsFile: '/h' }, { scope, multiplex: '/data/ssh' }), 'ControlPath')!
  assert.match(path('alice'), /^ControlPath=\/data\/ssh\/[0-9a-f]{12}-%C$/)
  assert.equal(path('alice'), path('alice'))
  assert.notEqual(path('alice'), path('bob'))
  assert.notEqual(path('alice', '/k1'), path('alice', '/k2'))
})
