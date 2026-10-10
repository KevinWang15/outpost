import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { NativeInput } from '../backend/native-input.ts'
import { NativePaste } from '../backend/native-paste.ts'

const image = { mediaType: 'image/png', data: 'aW1hZ2U=' }
const result = { path: '/target/image.png', reference: '/target/image.png', injected: false }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { resolve, promise } }

test('native paste keys are recognized across chunks, while text pastes, replies, release events and other keys stay opaque', async () => {
  for (let split = 0; split <= 6; split++) {
    const writes = [], actions = []
    const keys = new NativeInput(data => writes.push(data), retry => actions.push(retry))
    keys.push('hé🙂'); keys.push('\x1b[19~'.slice(0, split)); keys.push('\x1b[19~'.slice(split))
    keys.push('\x1b[19;2~\x1b[9001~\x1b[9002~')
    keys.push('\x1b[19;1:1~\x1b[19;1:2~\x1b[19;1:3~\x1b[19;66:1~')
    const opaque = '\x1b[200~literal\x1b[19~\x1b[9001~\x1b[201~\x1b]52;c;\x1b[9001~\x07\x1bPdata\x07\x1b[9001~\x1b\\\x1b[19;5~\x1b[A\x03'
    for (const character of opaque) keys.push(character)
    assert.equal(writes.join(''), 'hé🙂' + opaque)
    assert.deepEqual(actions, [false, true, false, true, false, true])
    keys.push('\x1b')
    await delay(60)
    assert.equal(writes.at(-1), '\x1b')
    keys.reset()
  }
})

test('native image paste serializes gestures, uploads once, and retains its image and uploaded reference for explicit retry', async () => {
  let current = {}, failure = true, reads = 0, uploads = 0
  const inserted = [], statuses = [], read = deferred()
  const paste = new NativePaste({
    connection: () => current,
    read: async () => { reads++; return read.promise },
    upload: async value => { assert.deepEqual(value, image); uploads++; return result },
    insert: (connection, text) => { if (failure) throw new Error('Input failed'); inserted.push({ connection, text }) },
    status: message => statuses.push(message),
  })
  const first = paste.paste()
  await paste.paste()
  assert.equal(reads, 1)
  read.resolve({ kind: 'image', image })
  await first
  assert.equal(uploads, 1)
  assert.match(statuses.at(-1), /Paste kept/)
  current = {}; failure = false
  await paste.paste(true)
  assert.equal(reads, 1)
  assert.equal(uploads, 1)
  assert.deepEqual(inserted, [{ connection: current, text: result.reference }])
  await paste.paste(true)
  assert.match(statuses.at(-1), /no failed paste/)
  paste.dispose()
})

test('native uploads cannot insert into a reconnected terminal, and a stale clipboard read cannot start an upload', async () => {
  let connection = {}, uploads = 0
  const statuses = [], inserts = [], read = deferred(), upload = deferred()
  const paste = new NativePaste({
    connection: () => connection, read: async () => read.promise,
    upload: async () => { uploads++; return upload.promise },
    insert: (...args) => inserts.push(args), status: message => statuses.push(message),
  })
  const reading = paste.paste()
  connection = {}
  read.resolve({ kind: 'image', image }); await reading
  assert.equal(uploads, 0)
  assert.match(statuses.at(-1), /connection changed/)
  const uploading = paste.paste(true)
  connection = {}
  upload.resolve(result); await uploading
  assert.deepEqual(inserts, [])
  await paste.paste(true)
  assert.equal(uploads, 1)
  assert.deepEqual(inserts, [[connection, result.reference]])
  paste.dispose()
})

test('native tmux injection is not duplicated, text does not upload, and closing cancels without late clipboard insertion', async () => {
  let clipboard = { kind: 'image', image }, uploads = 0, reads = 0, readSignal
  const connection = {}, inserts = [], statuses = []
  const paste = new NativePaste({
    connection: () => connection,
    read: async signal => { reads++; readSignal = signal; return clipboard },
    upload: async () => { uploads++; return { ...result, injected: true } },
    insert: (...args) => inserts.push(args), status: message => statuses.push(message),
  })
  await paste.paste()
  assert.equal(uploads, 1); assert.deepEqual(inserts, [])
  clipboard = { kind: 'text', text: '本地 clipboard\nsecond line' }
  await paste.paste()
  assert.equal(uploads, 1)
  assert.deepEqual(inserts, [[connection, clipboard.text]])
  clipboard = { kind: 'empty' }
  await paste.paste()
  assert.match(statuses.at(-1), /no image or text/)
  const pending = deferred()
  clipboard = pending.promise
  const completion = paste.paste()
  paste.dispose()
  assert.equal(readSignal.aborted, true)
  pending.resolve({ kind: 'image', image }); await completion
  assert.equal(uploads, 1)
  await paste.paste()
  assert.equal(reads, 4)
})
