import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { SessionClient } from '../../backend/sessions'
import { FrameDecoder, terminalControl } from '../../shared/node/terminalFrames'
import headless from '@xterm/headless'
import { CheckpointReader } from '../../shared/terminalCheckpoint'
import { scrollbackLines, type Scrollback } from '../../shared/terminalService'
import { localMachine } from './helpers'

test(
  'a detached machine keeps unlimited output and restores only the rows each viewer requests',
  { timeout: 60_000 },
  async t => {
    const { home, context, streams } = await localMachine(t, 'outpost-scrollback-', {
      kind: 'local',
      id: 'scrollback',
      name: 'Scrollback',
      tools: ['claude'],
      createdAt: new Date().toISOString(),
    })
    const client = new SessionClient()
    const session = await client.create(context, {
      name: 'History',
      rootDir: '~/history',
      tool: 'claude',
      createDirectory: true,
    })
    const dir = join(home, 'history')
    await writeFile(
      join(home, 'bin', 'claude'),
      `#!/bin/sh
while [ ! -f emit ]; do sleep 0.05; done
awk 'BEGIN { print "first-detached-row"; for (i = 0; i < 25000; i++) print i; print "last-detached-row" }'
touch emitted
read -r line
`,
    )
    async function attach(scrollback?: Scrollback) {
      const stream = await client.attach(context, session.id, 40, 10, true, undefined, scrollback)
      streams.push(stream)
      const events = new EventEmitter()
      const ready = once(events, 'ready')
      const decoder = new FrameDecoder()
      const term = new headless.Terminal({ allowProposedApi: true, scrollback: scrollbackLines(scrollback) })
      const reader = new CheckpointReader(term, scrollbackLines(scrollback))
      stream.onClose(error => {
        if (error && events.listenerCount('error')) events.emit('error', error)
      })
      stream.onData(bytes => {
        for (const frame of decoder.feed(bytes)) {
          if (frame.kind !== 'C') continue
          const msg = JSON.parse(frame.payload.toString())
          if (msg.type === 'error') events.emit('error', new Error(msg.message))
          if (msg.type === 'ready') events.emit('ready')
          if (msg.type === 'result' && msg.id === 'policy') events.emit('pong')
          if (msg.type === 'restore') reader.accept(msg.checkpoint)
        }
      })
      await ready
      const buf = term.buffer.normal
      const snapshot = {
        history: buf.baseY,
        first: buf.getLine(0)!.translateToString(true),
        last: buf.getLine(buf.baseY + buf.cursorY - 1)?.translateToString(true),
      }
      term.dispose()
      return { ...snapshot, stream, events }
    }
    const desktop = await attach(50)
    desktop.stream.write(terminalControl({ type: 'scrollback', lines: 'unlimited' }))
    const pong = once(desktop.events, 'pong')
    desktop.stream.write(terminalControl({ type: 'ping', id: 'policy' }))
    await pong
    desktop.stream.end()
    await writeFile(join(dir, 'emit'), '')
    while (
      !(await access(join(dir, 'emitted')).then(
        () => true,
        () => false,
      ))
    )
      await delay(30)
    const browser = await attach()
    assert.equal(browser.history, 10_000)
    assert.equal(browser.last, 'last-detached-row')
    const bounded = await attach(12)
    assert.equal(bounded.history, 12)
    assert.equal(bounded.last, browser.last)
    const full = await attach('unlimited')
    assert.ok(full.history > 25_000 - 10)
    assert.equal(full.first, 'first-detached-row')
    assert.equal(full.last, browser.last)
    const second = await attach('unlimited')
    assert.equal(second.first, full.first)
    full.stream.end()
    second.stream.end()
    browser.stream.end()
    bounded.stream.end()
  },
)
