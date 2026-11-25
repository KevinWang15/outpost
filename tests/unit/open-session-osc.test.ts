import assert from 'node:assert/strict'
import test from 'node:test'
import {
  encodeOpenSessionOsc,
  MAX_OPEN_SESSION_OSC_BYTES,
  OPEN_SESSION_OSC,
  OPEN_SESSION_PREFIX,
  parseOpenSessionOscData,
} from '../../shared/openSessionSignal'
import {
  formatEnvText,
  parseEnvAssignment,
  parseEnvText,
  parseMcpText,
  parseNewArgs,
  pickDefaultTool,
  uniqueDefaultName,
} from '../../machine/cli'

const UUID = '11111111-2222-4333-8444-555555555555'

test('encodeOpenSessionOsc and parseOpenSessionOscData round-trip plain, tmux, and screen sequences', () => {
  const plain = encodeOpenSessionOsc(
    {
      sessionId: UUID,
      origin: 'https://outpost.example:8443/',
      targetId: 'target-1',
      name: 'my-project',
      tool: 'claude',
      hostname: 'devbox',
    },
    {},
  )
  assert.ok(plain.startsWith(`\x1b]${OPEN_SESSION_OSC};${OPEN_SESSION_PREFIX}`))
  assert.ok(plain.endsWith('\x07'))

  const oscData = plain.slice(`\x1b]${OPEN_SESSION_OSC};`.length, -1)
  const parsed = parseOpenSessionOscData(oscData)
  assert.deepEqual(parsed, {
    v: 1,
    sessionId: UUID,
    origin: 'https://outpost.example:8443',
    targetId: 'target-1',
    name: 'my-project',
    tool: 'claude',
    hostname: 'devbox',
  })

  // tmux DCS passthrough doubles every ESC and wraps in \x1bPtmux;...\x1b\\
  const tmux = encodeOpenSessionOsc({ sessionId: UUID }, { TMUX: '/tmp/tmux-1000/default,123,0' })
  assert.ok(tmux.startsWith('\x1bPtmux;\x1b\x1b]7770;'))
  assert.ok(tmux.endsWith('\x07\x1b\\'))
  const unwrappedTmux = tmux.slice('\x1bPtmux;'.length, -2).replaceAll('\x1b\x1b', '\x1b')
  assert.equal(unwrappedTmux, encodeOpenSessionOsc({ sessionId: UUID }, {}))

  // screen DCS passthrough wraps in \x1bP...\x1b\\
  const screen = encodeOpenSessionOsc({ sessionId: UUID }, { STY: '1234.pts-0.host' })
  assert.ok(screen.startsWith('\x1bP\x1b]7770;'))
  assert.ok(screen.endsWith('\x07\x1b\\'))
})

test('parseOpenSessionOscData rejects invalid prefixes, UUIDs, origins, versions, and oversized payloads', () => {
  assert.equal(parseOpenSessionOscData('other;data'), null)
  assert.equal(parseOpenSessionOscData(`${OPEN_SESSION_PREFIX}!!!not-base64`), null)

  const encodeRaw = (obj: unknown) =>
    `${OPEN_SESSION_PREFIX}${Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')}`

  assert.equal(parseOpenSessionOscData(encodeRaw({ v: 2, sessionId: UUID })), null)
  assert.equal(parseOpenSessionOscData(encodeRaw({ v: 1, sessionId: 'not-a-uuid' })), null)
  assert.equal(parseOpenSessionOscData(encodeRaw({ v: 1, sessionId: UUID, origin: 'javascript:alert(1)' })), null)
  assert.equal(
    parseOpenSessionOscData(encodeRaw({ v: 1, sessionId: UUID, origin: 'https://outpost.example/path' })),
    null,
  )
  assert.equal(parseOpenSessionOscData(encodeRaw({ v: 1, sessionId: UUID, tool: 'not-a-tool' })), null)
  assert.equal(parseOpenSessionOscData(`${OPEN_SESSION_PREFIX}${'A'.repeat(MAX_OPEN_SESSION_OSC_BYTES + 10)}`), null)
})

test('CLI argument parsing supports short/long flags, = syntax, repeatable env, and rejects invalid options', () => {
  const parsed = parseNewArgs([
    './repo',
    '-n',
    'Feature Work',
    '--tool=codex',
    '--create-dir',
    '--instructions',
    'Focus on tests',
    '--model=gpt-5',
    '--mode',
    'plan',
    '--args=--full-auto',
    '-e',
    'FOO=bar=baz',
    '--env=NUM=42',
    '--copy-from',
    'base-session',
    '--no-open',
    '-y',
    '--json',
  ])
  assert.equal(parsed.dir, './repo')
  assert.equal(parsed.name, 'Feature Work')
  assert.equal(parsed.tool, 'codex')
  assert.equal(parsed.createDirectory, true)
  assert.equal(parsed.instructions, 'Focus on tests')
  assert.equal(parsed.model, 'gpt-5')
  assert.equal(parsed.mode, 'plan')
  assert.equal(parsed.args, '--full-auto')
  assert.deepEqual(parsed.env, { FOO: 'bar=baz', NUM: '42' })
  assert.equal(parsed.copyFrom, 'base-session')
  assert.equal(parsed.open, false)
  assert.equal(parsed.yes, true)
  assert.equal(parsed.json, true)

  assert.throws(() => parseNewArgs(['--tool', 'unknown-agent']), /Unknown coding tool/)
  assert.throws(() => parseNewArgs(['--bogus']), /Unknown option/)
  assert.throws(() => parseNewArgs(['dir1', 'dir2']), /Unexpected argument/)
  assert.throws(() => parseEnvAssignment('1INVALID=val'), /Invalid environment variable name/)
  assert.throws(() => parseEnvAssignment('NO_EQUALS'), /KEY=VALUE/)
})

test('env text, MCP JSON, unique default name, and default tool selection helpers', () => {
  assert.deepEqual(parseEnvText('A=1, B=two=three\nC=4'), { A: '1', B: 'two=three', C: '4' })
  assert.equal(formatEnvText({ A: '1', B: 'two' }), 'A=1 B=two')
  assert.deepEqual(parseMcpText('{"docs":{"type":"http","url":"https://example.com/mcp"}}', process.cwd()), {
    docs: { type: 'http', url: 'https://example.com/mcp' },
  })
  assert.deepEqual(parseMcpText('', process.cwd()), {})
  assert.throws(() => parseMcpText('[]', process.cwd()), /JSON object/)
  assert.throws(() => parseMcpText('{bad', process.cwd()), /Invalid MCP servers JSON/)

  assert.equal(uniqueDefaultName('/home/dev/outpost', []), 'outpost')
  assert.equal(uniqueDefaultName('/home/dev/outpost', ['Outpost']), 'outpost-2')
  assert.equal(uniqueDefaultName('/home/dev/outpost', ['outpost', 'outpost-2']), 'outpost-3')

  assert.equal(pickDefaultTool(['codex', 'claude'], []), 'codex')
  assert.equal(
    pickDefaultTool(
      ['claude', 'codex'],
      [
        { tool: 'claude', createdAt: '2026-01-01T00:00:00.000Z' },
        { tool: 'codex', createdAt: '2026-05-01T00:00:00.000Z' },
      ],
    ),
    'codex',
  )
  assert.equal(pickDefaultTool([], []), null)
})
