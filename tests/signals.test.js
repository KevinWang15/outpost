import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Signals } from '../backend/signals.ts'
import { browserUrl } from '../shared/signals.ts'

const owner = { userId: 'alice', authSessionId: 'login' }
const message = (type = 'browser.open', payload = { url: 'https://example.com/path?x=1&y=two' }) => ({ version: 1, id: randomUUID(), type, payload })

test('session tokens resolve identity, unknown signals fail without listeners, and generic payloads remain neutral', async t => {
  const signals = new Signals(() => true)
  t.after(() => signals.close())
  const token = signals.issue(owner, 'target', 'session')
  await assert.rejects(signals.dispatch('invalid', message()), { statusCode: 401 })
  await assert.rejects(signals.dispatch(token, message()), { statusCode: 503 })
  const events = []
  const stop = signals.listen('listener', owner, ['progress.update'], event => events.push(event), () => {})
  const signal = message('progress.update', { done: 2, total: 3, nested: ['漢字', false] })
  assert.deepEqual(await signals.dispatch(token, signal), { id: signal.id })
  assert.deepEqual(events, [{ ...signal, targetId: 'target', sessionId: 'session' }])
  stop()
  await assert.rejects(signals.dispatch(token, message('progress.update', null)), { statusCode: 503 })
  assert.equal(signals.issue(owner, 'target', 'session'), token)
})

test('concurrent retries deliver once to one focused listener and never replay after a disconnect', async t => {
  const signals = new Signals(() => true)
  t.after(() => signals.close())
  const token = signals.issue(owner, 'target', 'session'), first = [], second = [], foreign = []
  signals.listen('first', owner, ['browser.open'], event => first.push(event), () => {})
  const stop = signals.listen('second', owner, ['browser.open'], event => second.push(event), () => {})
  signals.listen('foreign', { ...owner, authSessionId: 'other-login' }, ['browser.open'], event => foreign.push(event), () => {})
  signals.activity('second', owner, true, true)
  signals.activity('foreign', { ...owner, authSessionId: 'other-login' }, true, true)
  const signal = message()
  await Promise.all(Array.from({ length: 20 }, () => signals.dispatch(token, signal)))
  assert.equal(first.length, 0); assert.equal(second.length, 1); assert.equal(foreign.length, 0)
  stop()
  await signals.dispatch(token, signal)
  assert.equal(first.length, 0, 'a delivered event is never reassigned')
  await assert.rejects(signals.dispatch(token, { ...signal, payload: { url: 'https://other.example' } }), { statusCode: 409 })
  await signals.dispatch(token, message())
  assert.equal(first.length, 1)
})

test('listeners cannot cross accounts or logins; logout and target/session revocation invalidate grants', async t => {
  const ended = new Set(), signals = new Signals(value => !ended.has(value.authSessionId))
  t.after(() => signals.close())
  const token = signals.issue(owner, 'target', 'one'), other = signals.issue(owner, 'target', 'two')
  signals.listen('one', { userId: 'bob', authSessionId: 'login-bob' }, ['browser.open'], () => assert.fail('cross-account delivery'), () => {})
  await assert.rejects(signals.dispatch(token, message()), { statusCode: 503 })
  assert.throws(() => signals.activity('one', owner, true, true), { statusCode: 404 })
  assert.throws(() => signals.listen('one', owner, ['browser.open'], () => {}, () => {}), { statusCode: 404 })
  signals.revoke(owner.userId, 'target', 'one')
  await assert.rejects(signals.dispatch(token, message()), { statusCode: 401 })
  await assert.rejects(signals.dispatch(other, message()), { statusCode: 503 })
  ended.add(owner.authSessionId)
  await assert.rejects(signals.dispatch(other, message()), { statusCode: 401 })
})

test('browser adapter validates URLs, local opening happens once, and handler failures are not retried', async t => {
  const signals = new Signals(() => true), opened = []
  t.after(() => signals.close())
  signals.define('browser.open', browserUrl)
  signals.registerLocal('browser.open', event => { opened.push(browserUrl(event.payload)) })
  const token = signals.issue({ userId: 'local', authSessionId: 'local' }, 'target', 'session')
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'https://user:password@example.com/', 'https://example.com/\nnext']) {
    await assert.rejects(signals.dispatch(token, message('browser.open', { url })), { statusCode: 400 })
  }
  const signal = message()
  await Promise.all([signals.dispatch(token, signal), signals.dispatch(token, signal)])
  assert.deepEqual(opened, ['https://example.com/path?x=1&y=two'])
  let attempts = 0
  signals.registerLocal('test.failure', () => { attempts++; throw new Error('Cannot handle') })
  const failure = message('test.failure', {})
  await assert.rejects(signals.dispatch(token, failure), /Cannot handle/)
  await assert.rejects(signals.dispatch(token, failure), /Cannot handle/)
  assert.equal(attempts, 1)
})

test('invalid envelopes fail cleanly and rate limits preserve retries and isolate sessions', async t => {
  const signals = new Signals(() => true), received = []
  t.after(() => signals.close())
  signals.listen('listener', owner, ['work.progress'], event => received.push(event), () => {})
  const token = signals.issue(owner, 'target', 'one'), other = signals.issue(owner, 'target', 'two')
  for (const input of [null, [], {}, { ...message(), version: 2 }, { ...message(), id: 'line\nbreak' },
    message('invalid-type', 'x'.repeat(32 * 1024)), { ...message(), extra: true },
    message('work.progress', JSON.parse('['.repeat(10000) + '0' + ']'.repeat(10000)))]) {
    await assert.rejects(signals.dispatch(token, input), { statusCode: 400 })
  }
  const first = message('work.progress', { done: 1 })
  await signals.dispatch(token, first)
  for (let i = 1; i < 120; i++) await signals.dispatch(token, message('work.progress', { done: i + 1 }))
  await assert.rejects(signals.dispatch(token, message('work.progress', { done: 121 })), { statusCode: 429 })
  await signals.dispatch(token, first)
  assert.equal(received.length, 120, 'retries use their stored result without another delivery or rate-limit charge')
  await signals.dispatch(other, first)
  assert.equal(received.length, 121, 'one busy session cannot exhaust another session’s quota')
})
