import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { AppError } from '../../backend/errors'
import { runCommand, runProtocol, type Command } from '../../backend/process'
import { SessionClient, type TargetContext } from '../../backend/sessions'
import { SoftwareClient } from '../../backend/software'
import { Workspace } from '../../backend/workspace'
import { requiredSoftware } from '../../shared/model'

const muxError = 'mux_client_request_session: read from master failed: Connection reset by peer\n'
const success = 'OUTPOST_RESULT:{"ok":true,"data":{"recovered":true}}\n'

interface Attempt {
  code: number
  stdout?: string
  stderr?: string
  delayMs?: number
}
interface Record {
  phase: string
  input: string
  environment?: string
}

// Real child processes consume stdin and record each invocation. They replace
// SSH only at the executable boundary; the production process runner is intact.
const worker = `
const { appendFileSync } = require('node:fs')
const [log, phase, settings] = process.argv.slice(1)
const config = JSON.parse(settings)
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks)
  appendFileSync(log, JSON.stringify({
    phase, input: input.toString('base64'), environment: process.env.OUTPOST_RETRY_FIXTURE
  }) + '\\n')
  const finish = () => {
    const marker = input.toString().match(/OUTPOST_SOFTWARE_[\\w-]+/)?.[0] ?? ''
    process.stdout.write((config.stdout ?? '').replace('$MARKER', marker))
    process.stderr.write(config.stderr ?? '')
    process.exitCode = config.code
  }
  if (config.delayMs) setTimeout(finish, config.delayMs)
  else finish()
})
`

async function fixture(
  t: test.TestContext,
  first: Attempt = { code: 255, stderr: muxError },
  second: Attempt = { code: 0, stdout: success },
) {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-retry-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const log = join(directory, 'attempts.jsonl')
  const args = (phase: string, attempt: Attempt) => [
    '--input-type=commonjs',
    '-e',
    worker,
    log,
    phase,
    JSON.stringify(attempt),
  ]
  const command: Command = {
    executable: process.execPath,
    args: args('first', first),
    label: 'Fixture',
    retry: { args: args('second', second), when: result => result.code === 255 },
  }
  const records = async (): Promise<Record[]> => {
    const text = await readFile(log, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    return text.trim()
      ? text
          .trim()
          .split('\n')
          .map(line => JSON.parse(line))
      : []
  }
  const waitFor = async (phase: string) => {
    for (let tries = 0; tries < 500; tries++) {
      if ((await records()).some(record => record.phase === phase)) return
      await delay(10, undefined, { signal: t.signal })
    }
    assert.fail(`Child never reached ${phase}`)
  }
  const context: TargetContext = {
    owner: { userId: 'local', loginId: 'local' },
    target: { id: 'target', kind: 'ssh', name: 'Fixture', host: 'unused', tools: ['claude'], createdAt: '' },
    workspace: new Workspace(directory),
    transport: { label: command.label, runtime: () => command, management: () => command },
  }
  return { command, records, waitFor, context }
}

const status = (code: number) => (error: unknown) => error instanceof AppError && error.statusCode === code

test('recovery replays the exact binary prefix, stdin and environment once', async t => {
  const { command, records } = await fixture(t)
  command.input = Buffer.from([0, 1, 255, 128])
  const stdin = Buffer.from('payload 🦊\0with binary data')
  const env = { ...process.env, OUTPOST_RETRY_FIXTURE: 'original environment' }
  const result = await runProtocol(command, stdin, { readOnly: true, env })
  assert.deepEqual(result, { recovered: true })
  assert.deepEqual(
    await records(),
    ['first', 'second'].map(phase => ({
      phase,
      input: Buffer.concat([command.input!, stdin]).toString('base64'),
      environment: env.OUTPOST_RETRY_FIXTURE,
    })),
  )
})

test('a second failure surfaces its error and cannot start a third attempt', async t => {
  const { command, records } = await fixture(t, undefined, { code: 255, stderr: 'fresh connection failed' })
  await assert.rejects(runProtocol(command, '', { readOnly: true }), /fresh connection failed/)
  assert.deepEqual(
    (await records()).map(record => record.phase),
    ['first', 'second'],
  )
})

test('successful operations do not recover', async t => {
  const { command, records } = await fixture(t, { code: 0, stdout: success })
  assert.deepEqual(await runProtocol(command, '', { readOnly: true }), { recovered: true })
  assert.equal((await records()).length, 1)
})

test('mutations and streaming callers never consult the recovery policy', async t => {
  for (const mode of ['default', 'mutation', 'stream'] as const) {
    await t.test(mode, async t => {
      const { command, records } = await fixture(t)
      command.retry!.when = () => assert.fail('Unsafe caller reached retry policy')
      let output = ''
      const options =
        mode === 'default'
          ? {}
          : mode === 'mutation'
            ? { readOnly: false }
            : {
                readOnly: true,
                onOutput: (text: string) => {
                  output += text
                },
              }
      assert.equal((await runCommand(command, '', options)).code, 255)
      assert.equal((await records()).length, 1)
      if (mode === 'stream') assert.equal(output, muxError)
    })
  }
})

test('cancellation between attempts prevents starting the replacement process', async t => {
  const { command, records } = await fixture(t)
  const abort = new AbortController()
  command.retry!.when = () => {
    abort.abort()
    return true
  }
  await assert.rejects(runCommand(command, '', { readOnly: true, signal: abort.signal }), status(502))
  assert.deepEqual(
    (await records()).map(record => record.phase),
    ['first'],
  )
})

test('an exhausted original deadline prevents starting the replacement process', async t => {
  const { command, records } = await fixture(t)
  let now = 0
  t.mock.method(performance, 'now', () => now)
  command.retry!.when = () => {
    now = 10_001
    return true
  }
  await assert.rejects(runCommand(command, '', { readOnly: true, timeoutMs: 10_000 }), status(504))
  assert.deepEqual(
    (await records()).map(record => record.phase),
    ['first'],
  )
})

test('recovery receives only the remaining time from the original deadline', async t => {
  const { command, records } = await fixture(t, undefined, { code: 0, stdout: success, delayMs: 2000 })
  let now = 0
  t.mock.method(performance, 'now', () => now)
  command.retry!.when = () => {
    now = 9000
    return true
  }
  // If the retry resets the 10-second deadline this would succeed after 2s.
  // With 9s already spent, the live replacement must be stopped after 1s.
  await assert.rejects(runCommand(command, '', { readOnly: true, timeoutMs: 10_000 }), status(504))
  assert.deepEqual(
    (await records()).map(record => record.phase),
    ['first', 'second'],
  )
})

test('cancellation stops either live attempt without launching another', async t => {
  for (const phase of ['first', 'second']) {
    await t.test(phase, async t => {
      const stalled = { code: 255, stderr: muxError, delayMs: 10_000 }
      const { command, records, waitFor } = await fixture(t, phase === 'first' ? stalled : undefined, stalled)
      const abort = new AbortController()
      const pending = assert.rejects(runCommand(command, '', { readOnly: true, signal: abort.signal }), status(502))
      try {
        await waitFor(phase)
      } finally {
        abort.abort()
        await pending
      }
      assert.deepEqual(
        (await records()).map(record => record.phase),
        phase === 'first' ? ['first'] : ['first', 'second'],
      )
    })
  }
})

test('a timed-out or unlaunchable command never consults the recovery policy', async t => {
  const { command } = await fixture(t, { code: 255, stderr: muxError, delayMs: 10_000 })
  command.retry!.when = () => assert.fail('A rejected attempt reached retry policy')
  await assert.rejects(runCommand(command, '', { readOnly: true, timeoutMs: 100 }), status(504))
  await assert.rejects(
    runCommand({ ...command, executable: join(tmpdir(), 'outpost-no-such-executable') }, '', {
      readOnly: true,
    }),
    /Could not launch Fixture/,
  )
})

test('session reads opt into recovery and replay the runtime payload', async t => {
  const sessions = new SessionClient()
  const reads = {
    list: (context: TargetContext) => sessions.list(context),
    get: (context: TargetContext) => sessions.get(context, 'session'),
    directories: (context: TargetContext) => sessions.directories(context, '/work'),
    search: (context: TargetContext) => sessions.search(context, { query: 'hello' }),
  }
  for (const [name, read] of Object.entries(reads)) {
    await t.test(name, async t => {
      const { context, records } = await fixture(t)
      assert.deepEqual(await read(context), { recovered: true })
      const attempts = await records()
      assert.deepEqual(
        attempts.map(record => record.phase),
        ['first', 'second'],
      )
      assert.ok(Buffer.from(attempts[0].input, 'base64').length > 1000, 'Runtime prefix must be uploaded')
      assert.equal(attempts[0].input, attempts[1].input)
    })
  }
})

test('every session mutation preserves the single-attempt contract', async t => {
  const sessions = new SessionClient()
  const input = { name: 'Session', rootDir: '/work', tool: 'claude' as const }
  const mutations = {
    create: (context: TargetContext) => sessions.create(context, input),
    'idempotent create': (context: TargetContext) => sessions.create(context, input, 'a'.repeat(64)),
    fork: (context: TargetContext) => sessions.fork(context, 'session', { branch: 'feature', rootDir: '/fork' }),
    acknowledge: (context: TargetContext) => sessions.acknowledge(context, 'session', 'completion'),
    terminate: (context: TargetContext) => sessions.terminate(context, 'session'),
    remove: (context: TargetContext) => sessions.remove(context, 'session'),
    upload: (context: TargetContext) =>
      sessions.uploadImage(context, 'session', Buffer.from([1]), 'image/png', t.signal),
  }
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async t => {
      const { context, records } = await fixture(t)
      await assert.rejects(mutate(context), /Fixture failed \(255\)/)
      assert.deepEqual(
        (await records()).map(record => record.phase),
        ['first'],
      )
    })
  }
})

test('software inspection can recover while installation streams only one invocation', async t => {
  const software = new SoftwareClient()
  await t.test('inspect', async t => {
    const { context, command, records } = await fixture(t)
    const response = [
      '',
      '$MARKER',
      '/root',
      '0',
      'root',
      '/bin/bash',
      ...requiredSoftware(context.target).flatMap(id => [id, '', '127', '']),
      'END',
      '',
    ].join('\0')
    command.retry!.args[command.retry!.args.length - 1] = JSON.stringify({ code: 0, stdout: response })
    const report = await software.inspect(context)
    assert.equal(report.environment.home, '/root')
    assert.ok(report.software.every(item => item.status === 'missing'))
    const attempts = await records()
    assert.deepEqual(
      attempts.map(record => record.phase),
      ['first', 'second'],
    )
    assert.equal(attempts[0].input, attempts[1].input)
  })
  await t.test('install', async t => {
    const { context, records } = await fixture(t)
    let output = ''
    assert.equal(
      await software.install(
        context,
        'installation script',
        text => {
          output += text
        },
        t.signal,
      ),
      255,
    )
    assert.equal(output, muxError)
    assert.deepEqual(
      (await records()).map(record => record.phase),
      ['first'],
    )
  })
})
