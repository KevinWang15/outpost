// Messages typed into a terminal session through its machine's node: only when
// the agent is idle and nobody is typing or drafting, held in manual mode until
// delivered, each once, with the agent's reply read from its transcript.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { Target } from '../../shared/model'
import { FrameDecoder, terminalControl, terminalFrame } from '../../shared/node/terminalFrames'
import type { Stream } from '../../backend/machines'
import { SessionClient, type TerminalDelivery } from '../../backend/sessions'
import { localMachine } from './helpers'

const settings: Target = {
  kind: 'local',
  id: 'delivery-machine',
  name: 'Delivery machine',
  tools: ['claude'],
  createdAt: '2026-11-01T00:00:00Z',
}
const until = async (check: () => Promise<boolean> | boolean, label: string, timeout = 20_000) => {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** A viewer of the terminal, as the broker is. */
function viewer(stream: Stream) {
  const decoder = new FrameDecoder()
  const state = { output: '', ready: false, waiting: 0 }
  stream.onData(bytes => {
    for (const frame of decoder.feed(bytes)) {
      if (frame.kind === 'O') state.output += frame.payload.toString()
      else if (frame.kind === 'C') {
        const message = JSON.parse(frame.payload.toString())
        if (message.type === 'ready') state.ready = true
        if (message.type === 'deliveries') state.waiting = message.waiting
      }
    }
  })
  return { state, send: (message: object) => stream.write(terminalControl(message)) }
}

test('a terminal session takes messages only when nothing is in the way, once each', { timeout: 120_000 }, async t => {
  const { home, context, streams } = await localMachine(t, 'outpost-delivery-', settings)
  const sessions = new SessionClient()
  const session = await sessions.create(context, {
    name: 'Builder',
    rootDir: '~/builder',
    tool: 'claude',
    createDirectory: true,
  })
  const project = join(home, 'builder')
  await writeFile(join(project, 'answer-prompts'), '')
  await writeFile(join(project, 'capture-input'), '')
  const stream = await sessions.attach(context, session.id, 100, 30, true)
  streams.push(stream)
  const terminal = viewer(stream)
  await until(() => terminal.state.ready, 'the terminal')
  const typed = async () => readFile(join(project, 'input.bin'), 'utf8').catch(() => '')
  const progress = async (key: string) =>
    (await sessions.deliveries(context, session.id, [key])).find(item => item.key === key)
  const settled = async (key: string) => {
    let last: TerminalDelivery | undefined
    await until(async () => {
      last = await progress(key)
      return last?.state === 'done' || last?.state === 'failed'
    }, `message ${key}`)
    return last!
  }

  await t.test('an idle agent gets the message typed in and its reply is returned', async () => {
    const first = await sessions.deliver(context, session.id, 'one', '[Outpost: message from @planner]\nRun the tests')
    assert.equal(first.key, 'one')
    const done = await settled('one')
    assert.equal(done.state, 'done', done.error ?? '')
    assert.equal(done.reply, 'Fixture reply to: Run the tests')
    // A resend of the same message changes nothing.
    assert.equal((await sessions.deliver(context, session.id, 'one', 'Run the tests')).state, 'done')
    assert.equal((await typed()).split('Run the tests').length - 1, 1)
  })

  await t.test('a draft in the message box holds messages until it is sent or cleared', async () => {
    terminal.send({ type: 'draft', active: true })
    await sessions.deliver(context, session.id, 'two', '[Outpost: message from @planner]\nCheck the logs')
    await until(() => terminal.state.waiting === 1, 'the waiting count')
    await new Promise(resolve => setTimeout(resolve, 4000))
    assert.equal((await progress('two'))?.state, 'waiting')
    assert.ok(!(await typed()).includes('Check the logs'))
    terminal.send({ type: 'draft', active: false })
    assert.equal((await settled('two')).reply, 'Fixture reply to: Check the logs')
    assert.equal(terminal.state.waiting, 0)
  })

  await t.test('a line you are typing holds messages until you press Enter', async () => {
    stream.write(terminalFrame('I', Buffer.from('half a line')))
    await sessions.deliver(context, session.id, 'three', '[Outpost: message from @planner]\nAfter your line')
    await new Promise(resolve => setTimeout(resolve, 4000))
    assert.equal((await progress('three'))?.state, 'waiting')
    // Your prompt runs first; the message goes in after it.
    stream.write(terminalFrame('I', Buffer.from('\r')))
    assert.equal((await settled('three')).reply, 'Fixture reply to: After your line')
    assert.ok((await typed()).includes('half a line\r'))
  })

  await t.test('in manual mode messages wait for Deliver now', async () => {
    const current = await sessions.get(context, session.id)
    await sessions.update(context, session.id, { revision: current.config.revision, delivery: 'manual' })
    await sessions.deliver(context, session.id, 'four', '[Outpost: message from @planner]\nOnly when asked')
    await new Promise(resolve => setTimeout(resolve, 5000))
    assert.equal((await progress('four'))?.state, 'waiting')
    assert.equal(terminal.state.waiting, 1)
    terminal.send({ type: 'deliver-now' })
    assert.equal((await settled('four')).reply, 'Fixture reply to: Only when asked')
  })
})
