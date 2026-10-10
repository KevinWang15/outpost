import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalImagePaste } from '../frontend/terminal-image-paste.ts'

const file = () => new File(['image bytes'], 'screenshot.png', { type: 'image/png' })
const image = { path: '/remote/screenshot.png', reference: '/remote/screenshot.png', injected: false }
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))

test('an image paste uploads once, reuses its reference after a rejected insert, and does not duplicate tmux insertion', async () => {
  const connection = {}, states = [], uploads = [], inserts = []
  let failure = true, injected = false
  const paste = new TerminalImagePaste({
    connection: () => connection, blocked: () => false,
    upload: async file => { uploads.push(file); return { ...image, injected } },
    insert: async (socket, reference) => { inserts.push({ socket, reference }); if (failure) throw new Error('SSH input rejected') },
    onChange: state => states.push(state),
  })
  paste.paste(file())
  paste.paste(file())
  await tick()
  assert.equal(uploads.length, 1)
  assert.equal(states.at(-1).canRetry, true)
  failure = false
  await paste.retry()
  assert.equal(uploads.length, 1)
  assert.deepEqual(inserts, [{ socket: connection, reference: image.reference }, { socket: connection, reference: image.reference }])
  assert.equal(states.at(-1), null)
  await paste.retry()
  assert.equal(inserts.length, 2)
  injected = true
  paste.paste(file())
  await tick()
  assert.equal(uploads.length, 2)
  assert.equal(inserts.length, 2)
})

test('a completed upload cannot paste across a reconnect, and explicit retry uses the retained file result', async () => {
  let connection = {}, uploads = 0
  const result = pending(), states = [], inserts = []
  const paste = new TerminalImagePaste({
    connection: () => connection, blocked: () => false,
    upload: async () => { uploads++; return result.promise },
    insert: async socket => { inserts.push(socket) }, onChange: state => states.push(state),
  })
  paste.paste(file())
  connection = {}
  result.resolve(image)
  await tick()
  assert.equal(inserts.length, 0)
  assert.match(states.at(-1).message, /Reconnect and retry/)
  await paste.retry()
  assert.deepEqual(inserts, [connection])
  assert.equal(uploads, 1)
})

test('invalid files never upload, offline and busy pastes remain retryable, and disposal aborts without late insertion', async () => {
  let connection = null, blocked = false, signal, uploads = 0
  const result = pending(), states = []
  const paste = new TerminalImagePaste({
    connection: () => connection, blocked: () => blocked,
    upload: async (_file, abort) => { uploads++; signal = abort; return result.promise },
    insert: async () => assert.fail('Disposed paste must not insert'), onChange: state => states.push(state),
  })
  paste.paste(new File(['<svg/>'], 'image.svg', { type: 'image/svg+xml' }))
  assert.equal(states.at(-1).canRetry, false)
  paste.paste(file())
  assert.match(states.at(-1).message, /Reconnect/)
  connection = {}; blocked = true
  await paste.retry()
  assert.equal(uploads, 0)
  assert.match(states.at(-1).message, /Wait for Send/)
  blocked = false
  const completion = paste.retry()
  assert.equal(signal.aborted, false)
  paste.dispose()
  assert.equal(signal.aborted, true)
  const count = states.length
  result.resolve(image)
  await completion
  assert.equal(states.length, count)
})
