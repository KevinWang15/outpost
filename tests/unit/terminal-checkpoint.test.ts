import assert from 'node:assert/strict'
import test from 'node:test'
import headless from '@xterm/headless'
import unicode from '@xterm/addon-unicode11'
import {
  checkpoint,
  CheckpointReader,
  headlessColors,
  remoteTerminalReplies,
  writeHeadless,
} from '../../shared/terminalCheckpoint'
import { Sequences } from '../../terminal-service/sequences'

function terminal(cols = 20, rows = 5) {
  const term = new headless.Terminal({ cols, rows, scrollback: 10_000, allowProposedApi: true, logLevel: 'off' })
  term.loadAddon(new unicode.Unicode11Addon())
  term.unicode.activeVersion = '11'
  return term
}

function capture(term: headless.Terminal) {
  // The wire copies each part before the event loop can advance.
  return [...checkpoint(term)].map(part => JSON.parse(JSON.stringify(part)))
}

function restore(source: headless.Terminal, destination: headless.Terminal) {
  const reader = new CheckpointReader(destination)
  for (const part of capture(source)) reader.accept(part)
}

test('checkpoint preserves styled/wide/combined cells, wrapping, cursor and subsequent edits', () => {
  const source = terminal(),
    destination = terminal()
  try {
    writeHeadless(source, '\x1b[31;44;1m中文 e\u0301 🙂\x1b[0m\r\n12345678901234567890')
    restore(source, destination)
    assert.deepEqual(capture(destination), capture(source))
    for (const text of ['Z', '\rupdated', '\x1b[2;3HEDIT', '\x1b[1K', '\r\nend']) {
      writeHeadless(source, text)
      writeHeadless(destination, text)
      assert.deepEqual(capture(destination), capture(source))
    }
  } finally {
    source.dispose()
    destination.dispose()
  }
})

test('checkpoint retains 10,000 history rows and honors screen vs scrollback erasure', () => {
  const source = terminal(),
    destination = terminal()
  try {
    writeHeadless(source, Array.from({ length: 10_050 }, (_, index) => `${index}\r\n`).join(''))
    assert.equal(source.buffer.normal.length, 10_005)
    restore(source, destination)
    assert.deepEqual(capture(destination), capture(source))
    writeHeadless(source, '\x1b[2J')
    assert.equal(source.buffer.normal.baseY, 10_000)
    writeHeadless(source, '\x1b[3J')
    assert.equal(source.buffer.normal.baseY, 0)
    restore(source, destination)
    assert.deepEqual(capture(destination), capture(source))
  } finally {
    source.dispose()
    destination.dispose()
  }
})

test('checkpoint preserves alternate buffer, main history, saved cursor, margins and application modes', () => {
  const source = terminal(),
    destination = terminal()
  try {
    writeHeadless(source, 'main\r\n'.repeat(12) + '\x1b[3;4H\x1b7\x1b[?1049h')
    writeHeadless(source, '\x1b[2;4r\x1b[?6h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?25l\x1b[?12h\x1b[5 qALT')
    restore(source, destination)
    assert.deepEqual(capture(destination), capture(source))
    for (const text of ['\r\n'.repeat(10), '\x1b[?1049l', '\x1b8RESTORED']) {
      writeHeadless(source, text)
      writeHeadless(destination, text)
      assert.deepEqual(capture(destination), capture(source))
    }
  } finally {
    source.dispose()
    destination.dispose()
  }
})

test('checkpoint preserves OSC 8 links without replaying bells or clipboard commands', () => {
  const source = terminal(),
    destination = terminal()
  let actions = 0
  destination.onBell(() => actions++)
  destination.parser.registerOscHandler(52, () => {
    actions++
    return true
  })
  try {
    writeHeadless(source, '\x1b]8;id=one;https://example.com\x1b\\link\x1b]8;;\x1b\\\x07\x1b]52;c;aGVsbG8=\x07')
    restore(source, destination)
    assert.equal(actions, 0)
    assert.deepEqual(capture(destination), capture(source))
    writeHeadless(source, '\r\nmore')
    writeHeadless(destination, '\r\nmore')
    assert.deepEqual(capture(destination), capture(source))
  } finally {
    source.dispose()
    destination.dispose()
  }
})

test('sequence boundaries survive every UTF-8/CSI/OSC split and discard oversized commands', () => {
  const bytes = Buffer.from('hello 中文🙂\x1b[31mred\x1b[0m\x1b]0;title\x1b\\!\x1b]0;cancel\x1b[2Jend')
  for (let split = 0; split <= bytes.length; split++) {
    const sequences = new Sequences()
    const source = terminal()
    try {
      const a = sequences.feed(bytes.subarray(0, split))
      writeHeadless(source, a)
      capture(source) // Must be safe to reconnect at this boundary.
      const b = sequences.feed(bytes.subarray(split))
      writeHeadless(source, b)
      capture(source)
      assert.equal(a + b, bytes.toString())
    } finally {
      source.dispose()
    }
  }
  const sequences = new Sequences()
  const output = sequences.feed(Buffer.from('\x1b]0;' + 'x'.repeat(1024 * 1024 + 10)))
  assert.ok(output.startsWith('\x18'))
})

test('headless answers queries offline; renderer replies are suppressed without stealing user input', () => {
  const source = terminal(),
    destination = terminal()
  const replies: string[] = [],
    inputs: string[] = []
  try {
    source.onData(data => replies.push(data))
    headlessColors(source, data => replies.push(data))
    writeHeadless(source, '\x1b]4;2;rgb:01/02/03\x07')
    restore(source, destination)
    assert.deepEqual(capture(destination), capture(source))
    writeHeadless(source, '\x1b[6n\x1b]11;?\x07')
    assert.equal(replies.length, 2)
    assert.equal(replies[1], '\x1b]11;rgb:0f0f/1717/2a2a\x1b\\')
    remoteTerminalReplies(destination)
    destination.onData(data => inputs.push(data))
    writeHeadless(destination, '\x1b[6n')
    destination.input('hello', true)
    destination.input('\x1b[I', false)
    assert.deepEqual(inputs, ['hello', '\x1b[I'])
  } finally {
    source.dispose()
    destination.dispose()
  }
})
