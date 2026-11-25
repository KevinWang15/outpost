import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { OPEN_SESSION_OSC, parseOpenSessionOscData } from '../../shared/openSessionSignal'
import {
  emitOpenSessionSequence,
  runAttachCommand,
  runInstallCliCommand,
  runListCommand,
  runNewCommand,
} from '../../machine/cli'
import { listSessions } from '../../machine/sessions'
import { statePath } from '../../machine/state'
import { machine, tools } from './fixtures'

function setupCli(t: TestContext) {
  const home = machine(t)
  const bin = tools(t, home)
  // Ensure PATH uses the platform delimiter (fixtures.ts uses ':' which is POSIX-only).
  if (delimiter !== ':') {
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`
  }
  const project = join(home, 'my-workspace')
  mkdirSync(project)
  return { home, bin, project }
}

async function captureOutput(fn: () => Promise<void> | void): Promise<{ logs: string[]; rawStdout: string }> {
  const logs: string[] = []
  let rawStdout = ''
  const origLog = console.log
  const origWrite = process.stdout.write.bind(process.stdout)
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  }
  process.stdout.write = ((chunk: string | Uint8Array) => {
    rawStdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }) as typeof process.stdout.write
  try {
    await fn()
  } finally {
    console.log = origLog
    process.stdout.write = origWrite
  }
  return { logs, rawStdout }
}

function extractOsc7770(raw: string) {
  const prefix = `\x1b]${OPEN_SESSION_OSC};`
  const start = raw.indexOf(prefix)
  if (start === -1) return null
  const end = raw.indexOf('\x07', start + prefix.length)
  if (end === -1) return null
  return parseOpenSessionOscData(raw.slice(start + prefix.length, end))
}

test('outpost new creates a session with pre-filled cwd defaults and emits OSC 7770 auto-open signal', async t => {
  const { project } = setupCli(t)
  process.env.OUTPOST_FORCE_OSC = '1'
  t.after(() => delete process.env.OUTPOST_FORCE_OSC)

  const { logs, rawStdout } = await captureOutput(() => runNewCommand(['-y'], project))
  const sessions = await listSessions()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].name, 'my-workspace')
  assert.equal(sessions[0].rootDir, project)
  assert.equal(sessions[0].tool, 'claude')

  const osc = extractOsc7770(rawStdout)
  assert.ok(osc, 'expected OSC 7770 open-session escape sequence')
  assert.equal(osc.sessionId, sessions[0].id)
  assert.equal(osc.name, 'my-workspace')
  assert.equal(osc.tool, 'claude')
  assert.ok(osc.hostname)
  assert.ok(logs.some(line => line.includes('Sent auto-open signal to Outpost terminal.')))

  // Outbound-enrolled machines also include origin + targetId in OSC 7770.
  const outbound = await captureOutput(() => {
    emitOpenSessionSequence(sessions[0], {
      origin: 'https://outpost.example',
      targetId: '11111111-2222-4333-8444-555555555555',
    })
  })
  const outboundOsc = extractOsc7770(outbound.rawStdout)
  assert.ok(outboundOsc)
  assert.equal(outboundOsc.origin, 'https://outpost.example')
  assert.equal(outboundOsc.targetId, '11111111-2222-4333-8444-555555555555')
})

test('outpost new supports --create-dir, launch options, --copy-from, --no-open, and --json', async t => {
  const { home, project } = setupCli(t)
  const freshDir = join(home, 'brand-new-dir')
  assert.equal(existsSync(freshDir), false)

  process.env.OUTPOST_FORCE_OSC = '1'
  t.after(() => delete process.env.OUTPOST_FORCE_OSC)

  // First session with full launch config and --no-open.
  const first = await captureOutput(() =>
    runNewCommand(
      [
        freshDir,
        '-y',
        '--json',
        '--no-open',
        '--create-dir',
        '--name',
        'Base',
        '--tool',
        'claude',
        '--instructions',
        'Stay concise',
        '--model',
        'opus',
        '--mode',
        'plan',
        '--args',
        '--verbose',
        '-e',
        'FOO=1',
        '-e',
        'BAR=2',
      ],
      project,
    ),
  )
  assert.equal(extractOsc7770(first.rawStdout), null, '--no-open must suppress OSC 7770')
  assert.equal(existsSync(freshDir), true)
  const created = JSON.parse(first.logs.join('\n'))
  assert.equal(created.name, 'Base')
  assert.equal(created.tool, 'claude')
  assert.equal(created.rootDir, freshDir)
  assert.equal(created.config.instructions, 'Stay concise')
  assert.equal(created.config.model, 'opus')
  assert.equal(created.config.mode, 'plan')
  assert.equal(created.config.args, '--verbose')
  assert.deepEqual(created.config.env, { FOO: '1', BAR: '2' })

  // Second session copies settings from "Base" and overrides one env var.
  const second = await captureOutput(() =>
    runNewCommand(['-y', '--json', '--no-open', '--copy-from', 'Base', '-e', 'BAR=99'], project),
  )
  const copied = JSON.parse(second.logs.join('\n'))
  assert.equal(copied.name, 'my-workspace')
  assert.equal(copied.tool, 'claude')
  assert.equal(copied.config.instructions, 'Stay concise')
  assert.equal(copied.config.model, 'opus')
  assert.equal(copied.config.mode, 'plan')
  assert.equal(copied.config.args, '--verbose')
  assert.deepEqual(copied.config.env, { FOO: '1', BAR: '99' })
})

test('outpost ls, attach, and install-cli work end-to-end on a machine', async t => {
  const { home, project } = setupCli(t)
  process.env.OUTPOST_FORCE_OSC = '1'
  t.after(() => delete process.env.OUTPOST_FORCE_OSC)

  await captureOutput(() => runNewCommand(['-y', '--no-open', '--name', 'Alpha'], project))

  const listed = await captureOutput(() => runListCommand(['--json']))
  const items = JSON.parse(listed.logs.join('\n'))
  assert.equal(items.length, 1)
  assert.equal(items[0].name, 'Alpha')

  const attached = await captureOutput(() => runAttachCommand(['alpha']))
  const osc = extractOsc7770(attached.rawStdout)
  assert.ok(osc)
  assert.equal(osc.sessionId, items[0].id)
  assert.equal(osc.name, 'Alpha')

  const installDir = join(home, 'custom-bin')
  await captureOutput(() => runInstallCliCommand(['--dir', installDir], project))
  const wrapper = join(installDir, 'outpost')
  assert.ok(statSync(wrapper).isFile())
  const content = readFileSync(wrapper, 'utf8')
  assert.ok(content.startsWith('#!/bin/sh\nexec '))
  assert.ok(existsSync(statePath('bin', 'outpost')))
})
